import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { google } from 'googleapis';
import inquirer from 'inquirer';
import open from 'open';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');
const TOKEN_DIR = path.join(process.cwd(), 'tokens');
const PROFILE_DIR = path.join(process.cwd(), 'profiles');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(TOKEN_DIR);
ensureDir(PROFILE_DIR);

function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(content).installed;
}

function createOAuthClient() {
  const { client_id, client_secret, redirect_uris } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

async function authorizeAccount() {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });
  console.log('\n1) 다음 URL을 브라우저에서 열어 로그인·허용하세요:\n', authUrl, '\n');
  await open(authUrl);
  const { code } = await inquirer.prompt({ name: 'code', message: '2) 브라우저에서 받은 코드를 입력하세요:' });
  const { tokens } = await oAuth2Client.getToken(code);
  const { accountName } = await inquirer.prompt({ name: 'accountName', message: '3) 이 토큰을 저장할 계정 식별용 이름을 입력하세요:' });
  fs.writeFileSync(path.join(TOKEN_DIR, `${accountName}.json`), JSON.stringify(tokens, null, 2));
  console.log(`✔ tokens/${accountName}.json 에 저장되었습니다.`);

  const profilePath = path.join(PROFILE_DIR, accountName);
  ensureDir(profilePath);
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log('\n4) Chrome 로그인 창이 열립니다. 로그인 후 창을 닫고 Enter를 누르세요.');
  const chromeProc = spawn(chromePath, [`--user-data-dir=${profilePath}`, '--new-window'], { detached: true, stdio: 'ignore' });
  chromeProc.unref();
  await inquirer.prompt({ name: 'dummy', message: '로그인 완료 후 Enter를 누르세요' });
}

function parseVideoId(input) {
  const m1 = input.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = input.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m2) return m2[1];
  const m3 = input.match(/\/embed\/([A-Za-z0-9_-]{11})/);
  if (m3) return m3[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  throw new Error('유효한 YouTube 영상 ID나 URL을 입력해 주세요.');
}

async function postComment() {
  const { rawInput } = await inquirer.prompt({ name: 'rawInput', message: '댓글을 달 YouTube 동영상 URL 또는 ID를 입력하세요:' });
  let videoId;
  try { videoId = parseVideoId(rawInput.trim()); } catch (err) { console.error('❌', err.message); return; }
  const files = fs.readdirSync(TOKEN_DIR).filter(f => f.endsWith('.json'));
  if (!files.length) { console.log('토큰이 없습니다. 먼저 계정을 인증하세요.'); return; }

  const tasks = [];
  while (true) {
    const { accountFile } = await inquirer.prompt({ type: 'list', name: 'accountFile', message: '댓글을 달 계정을 선택하세요:', choices: files });
    const { commentText } = await inquirer.prompt({ name: 'commentText', message: `[${accountFile}] 작성할 댓글 내용을 입력하세요:` });
    tasks.push({ accountFile, commentText });
    const { more } = await inquirer.prompt({ type: 'confirm', name: 'more', message: '다른 계정에도 댓글을 작성하시겠습니까?', default: false });
    if (!more) break;
  }

  for (const { accountFile, commentText } of tasks) {
    const oAuth2Client = createOAuthClient();
    const tokens = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, accountFile), 'utf-8'));
    oAuth2Client.setCredentials(tokens);
    const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
    try {
      const res = await youtube.commentThreads.insert({ part: 'snippet', requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: commentText } } } } });
      console.log(`✔ [${accountFile}] 댓글 게시됨 (ID: ${res.data.id})`);
    } catch (err) {
      console.error(`❌ [${accountFile}] 댓글 게시 오류:`, err.errors || err);
    }
  }
}

async function likeComment() {
  const { commentUrl } = await inquirer.prompt({ name: 'commentUrl', message: '👍 좋아요를 누를 하이라이트 댓글 URL을 입력하세요:' });
  let urlObj;
  try { urlObj = new URL(commentUrl); } catch { console.error('❌ 유효한 URL이 아닙니다.'); return; }
  const commentId = urlObj.searchParams.get('lc');
  if (!commentId) { console.error('❌ 댓글 ID를 URL에서 가져올 수 없습니다.'); return; }

  const accounts = fs.readdirSync(TOKEN_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.basename(f, '.json'));
  if (!accounts.length) { console.log('토큰이 없습니다. 먼저 계정을 인증하세요.'); return; }

  for (const accountName of accounts) {
    console.log(`\n[${accountName}] 좋아요 처리 중…`);
    const browser = await puppeteer.launch({
      headless: false,
      userDataDir: path.join(PROFILE_DIR, accountName),
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,800'],
      defaultViewport: { width: 1280, height: 800 }
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36');
      await page.evaluateOnNewDocument(() => delete navigator.__proto__.webdriver);
      await page.goto(commentUrl, { waitUntil: 'networkidle2' });

      // 적절한 like 버튼 선택자
      const likeSelector = 'ytd-toggle-button-renderer#like-button';
      await page.waitForSelector(likeSelector, { timeout: 10000 });
      await page.click(likeSelector);
      await page.waitForResponse(res => res.url().includes('action_like_comment') && res.status() === 200, { timeout: 10000 });
      console.log(`✔ [${accountName}] 성공`);
      // 사용자 확인 대기
      await inquirer.prompt({ name: 'confirm', message: '좋아요 확인 후 Enter를 눌러 다음 계정으로 이동하세요.' });
    } catch (err) {
      console.error(`❌ [${accountName}] 오류: ${err.message}`);
    } finally {
      await browser.close();
    }
  }
}

async function main() {
  while (true) {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: '원하는 작업 선택:',
      choices: [
        { name: '1) 새 계정 인증', value: 'auth' },
        { name: '2) 댓글 작성', value: 'comment' },
        { name: '3) 댓글 좋아요', value: 'like' },
        { name: '4) 종료', value: 'exit' }
      ]
    });

    if (action === 'auth') await authorizeAccount();
    else if (action === 'comment') await postComment();
    else if (action === 'like') await likeComment();
    else break;
  }
  console.log('프로그램 종료.');
}

main().catch(console.error);
