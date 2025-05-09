// index.js
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
const TOKEN_DIR       = path.join(process.cwd(), 'tokens');
const PROFILE_DIR     = path.join(process.cwd(), 'profiles');

// 디렉터리 보장
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
ensureDir(TOKEN_DIR);
ensureDir(PROFILE_DIR);

// credentials.json 로드
function loadCredentials() {
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  return JSON.parse(content).installed;
}

// OAuth2 클라이언트 생성
function createOAuthClient() {
  const { client_id, client_secret, redirect_uris } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

// 계정 인증 → 토큰 저장 + Chrome 프로필 로그인
async function authorizeAccount() {
  const oAuth2Client = createOAuthClient();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  console.log('\n1) 다음 URL을 브라우저에서 열어 로그인·허용하세요:\n', authUrl, '\n');
  await open(authUrl);

  const { code } = await inquirer.prompt({
    name: 'code',
    message: '2) 브라우저에서 받은 코드를 입력하세요:'
  });
  const { tokens } = await oAuth2Client.getToken(code);

  const { accountName } = await inquirer.prompt({
    name: 'accountName',
    message: '3) 이 토큰을 저장할 계정 식별용 이름을 입력하세요:'
  });

  // 토큰 저장
  const tokenPath = path.join(TOKEN_DIR, `${accountName}.json`);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`✔ tokens/${accountName}.json 에 저장되었습니다.`);

  // Chrome 프로필 디렉터리 생성
  const profilePath = path.join(PROFILE_DIR, accountName);
  ensureDir(profilePath);

  // 시스템 Chrome 경로 (Windows 예시)
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  console.log('\n4) Chrome 로그인 창이 열립니다. YouTube에 로그인한 뒤 창을 닫고 엔터를 누르세요.');
  const chromeProc = spawn(
    chromePath,
    [`--user-data-dir=${profilePath}`, '--new-window'],
    { detached: true, stdio: 'ignore' }
  );
  chromeProc.unref();
  await inquirer.prompt({
    name: 'dummy',
    message: '로그인 완료 후 Enter를 누르세요'
  });
}

// URL 또는 ID에서 YouTube 영상 ID만 추출
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

// 댓글 작성
async function postComment() {
  // 1) 영상 URL/ID 입력
  const { rawInput } = await inquirer.prompt({
    name: 'rawInput',
    message: '댓글을 달 YouTube 동영상 URL 또는 ID를 입력하세요:'
  });
  let videoId;
  try {
    videoId = parseVideoId(rawInput.trim());
  } catch (err) {
    console.error('❌', err.message);
    return;
  }

  // 2) 계정 선택
  const files = fs.readdirSync(TOKEN_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('토큰이 없습니다. 먼저 계정을 인증하세요.');
    return;
  }
  const { accountFile } = await inquirer.prompt({
    type: 'list',
    name: 'accountFile',
    message: '어느 계정으로 댓글을 달까요?',
    choices: files
  });

  // 3) OAuth2Client에 토큰 적용
  const oAuth2Client = createOAuthClient();
  const tokens = JSON.parse(fs.readFileSync(path.join(TOKEN_DIR, accountFile), 'utf-8'));
  oAuth2Client.setCredentials(tokens);

  // 4) 댓글 내용 입력
  const { commentText } = await inquirer.prompt({
    name: 'commentText',
    message: '작성할 댓글 내용을 입력하세요:'
  });

  // 5) 댓글 게시
  const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
  try {
    const res = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: {
        snippet: {
          videoId,
          topLevelComment: { snippet: { textOriginal: commentText } }
        }
      }
    });
    console.log('✔ 댓글 게시됨 (ID:', res.data.id, ')');
  } catch (err) {
    console.error('댓글 게시 오류:', err.errors || err);
  }
}

// 댓글 좋아요
async function likeComment() {
	const { commentUrl } = await inquirer.prompt({
	  name: 'commentUrl',
	  message: '👍 좋아요를 누를 하이라이트 댓글 URL을 입력하세요:'
	});
  
	let commentId;
	try {
	  commentId = new URL(commentUrl).searchParams.get('lc');
	  if (!commentId) throw new Error();
	} catch {
	  console.error('❌ 유효한 YouTube 댓글 URL이 아닙니다.');
	  return;
	}
  
	const profiles = await fsPromises.readdir(PROFILE_DIR, { withFileTypes: true })
	  .then(arr => arr.filter(d => d.isDirectory()).map(d => d.name));
	if (!profiles.length) {
	  console.log('프로필이 없습니다. 먼저 계정을 인증하세요.');
	  return;
	}
  
	for (let i = 0; i < profiles.length; i++) {
	  const prof = profiles[i];
	  process.stdout.write(`[${i+1}/${profiles.length}] ${prof} 좋아요 처리 중… `);
  
	  const browser = await puppeteer.launch({
		headless: false,
		userDataDir: path.join(PROFILE_DIR, prof),
		args: [
		  '--no-sandbox',
		  '--disable-setuid-sandbox',
		//   '--window-position=-10000,-10000'
		]
	  });
	  const page = await browser.newPage();
	  await page.goto(commentUrl, { waitUntil: 'networkidle2' });
  
	  // 1) 댓글 영역 로드 & 스크롤
	  await page.waitForSelector('ytd-comments', { timeout: 60000 });
	//   await page.evaluate(() => window.scrollBy(0, window.innerHeight));
	  await new Promise(r => setTimeout(r, 2000));
  
	  // 2) 해당 댓글 스레드를 찾아서 클릭
	  //    - $$eval: 페이지 내 모든 스레드를 돌며 URL 파라미터와 매칭
	  const clicked = await page.$$eval(
		'ytd-comment-thread-renderer',
		(threads, commentId) => {
		  for (const th of threads) {
			const link = th.querySelector('span#published-time-text a');
			if (link && link.href.includes(`lc=${commentId}`)) {
			  // linked 속성이 있는 <ytd-comment-view-model> 찾기
			  const hv = th.querySelector('ytd-comment-view-model[linked]');
			  if (!hv) continue;
			  const btn = hv.querySelector('ytd-comment-engagement-bar #like-button');
			  if (!btn) continue;
			  btn.click();
			  return true;
			}
		  }
		  return false;
		},
		commentId
	  );
  
	  if (clicked) {
		console.log('✔ 성공');
	  } else {
		console.log('❌ 찾을 수 없음');
	  }
  
	  await browser.close();
	}
  
	console.log('✅ 완료');
  }
  
  

// 메인 메뉴
async function main() {
  while (true) {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: '원하는 작업 선택:',
      choices: [
        { name: '1) 새 계정 인증', value: 'auth' },
        { name: '2) 댓글 작성',   value: 'comment' },
        { name: '3) 댓글 좋아요', value: 'like' },
        { name: '4) 종료',       value: 'exit' }
      ]
    });

    if (action === 'auth') {
      await authorizeAccount();
    } else if (action === 'comment') {
      await postComment();
    } else if (action === 'like') {
      await likeComment();
    } else {
      console.log('프로그램 종료합니다.');
      process.exit(0);
    }
  }
}

main().catch(err => console.error(err));
