#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { google } from 'googleapis';
import inquirer from 'inquirer';
import open from 'open';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Puppeteer Stealth 설정
puppeteer.use(StealthPlugin());

// YouTube API 스코프 및 경로 설정
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];
const CREDENTIALS_PATH = path.resolve('credentials.json');
const TOKEN_DIR = path.resolve('tokens');
const PROFILE_DIR = path.resolve('profiles');

// OAuth2 클라이언트 초기화
const { client_id, client_secret, redirect_uris } =
  JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8')).installed;
const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// YouTube URL 또는 ID에서 11자리 영상 ID 추출
const parseVideoId = input => {
  const pattern = /(?:[?&]v=|youtu\.be\/|\/embed\/)([A-Za-z0-9_-]{11})/;
  const m = input.match(pattern);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  throw new Error('유효한 YouTube 영상 ID 또는 URL을 입력하세요.');
};

// Puppeteer 옵션 (Chrome 탐지 방지)
const getPuppeteerOptions = userDataDir => ({
  headless: false,
  userDataDir,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled'
  ],
  defaultViewport: null,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
});

// 1) 계정 OAuth 인증 및 세션 저장
const authorizeAccount = async () => {
  // OAuth URL 열기
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  console.log(`\n1) 다음 URL을 브라우저에서 열어 OAuth 인증을 완료하세요:\n${authUrl}\n`);
  await open(authUrl);

  // 인증 코드 입력
  const { code } = await inquirer.prompt({ name: 'code', message: '2) 브라우저에서 받은 코드를 입력하세요:' });
  const { tokens } = await oauth2Client.getToken(code.trim());
  oauth2Client.setCredentials(tokens);

  // 토큰 저장
  const { accountName } = await inquirer.prompt({ name: 'accountName', message: '3) 저장할 계정 이름을 입력하세요:' });
  await fs.writeFile(path.join(TOKEN_DIR, `${accountName}.json`), JSON.stringify(tokens, null, 2));
  console.log(`✔ tokens/${accountName}.json 저장 완료`);

  // Chrome 자동 실행하여 로그인 세션 저장
  const profileDir = path.join(PROFILE_DIR, accountName);
  await fs.mkdir(profileDir, { recursive: true });
  console.log('\nChrome이 자동으로 실행됩니다. 로그인 후 창을 닫으면 진행됩니다.');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chromeProc = spawn(chromePath, [`--user-data-dir=${profileDir}`], { detached: true, stdio: 'ignore' });
  chromeProc.unref();
  await inquirer.prompt({ name: 'continue', message: '로그인 완료 후 Enter 키를 누르세요.' });
  console.log(`✔ profiles/${accountName} 세션 준비 완료`);
};

// 2) 댓글 작성 (계정별 개별 댓글 입력 + 딜레이)
const postComment = async () => {
  const files = (await fs.readdir(TOKEN_DIR)).filter(f => f.endsWith('.json'));
  if (!files.length) return console.log('⚠️ 인증된 계정이 없습니다. 먼저 계정을 인증하세요.');

  // 영상 ID 입력
  const { rawInput } = await inquirer.prompt({ name: 'rawInput', message: '댓글을 달 YouTube 동영상 URL 또는 ID:' });
  let videoId;
  try { videoId = parseVideoId(rawInput.trim()); } catch (e) { return console.error(e.message); }

  // 계정+댓글 페어 수집
  const pairs = [];
  let remaining = [...files];
  while (true) {
    const { action } = await inquirer.prompt({ type: 'list', name: 'action', message: `현재 수집된 항목: ${pairs.length}개`, choices: ['계정+댓글 추가', '수집 완료'] });
    if (action === '수집 완료') break;
    if (!remaining.length) { console.log('⚠️ 추가할 계정이 없습니다.'); break; }

    const { accountFile } = await inquirer.prompt({ type: 'list', name: 'accountFile', message: '계정 선택:', choices: remaining });
    const { commentText } = await inquirer.prompt({ name: 'commentText', message: `[*${accountFile}*] 댓글 내용:` });
    pairs.push({ accountFile, commentText });
    remaining = remaining.filter(n => n !== accountFile);
  }
  if (!pairs.length) return console.log('⚠️ 최소 하나 이상의 댓글을 입력해야 합니다.');

  // 딜레이 설정
  const { useDelay } = await inquirer.prompt({ type: 'confirm', name: 'useDelay', message: '계정별 딜레이 적용?', default: false });
  let delayMs = 0;
  if (useDelay) {
    const { delaySec } = await inquirer.prompt({ name: 'delaySec', message: '딜레이 시간(초):', validate: v => v > 0 });
    delayMs = Number(delaySec) * 1000;
  }

  // 댓글 게시
  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  for (let i = 0; i < pairs.length; i++) {
    const { accountFile, commentText } = pairs[i];
    const tokens = JSON.parse(await fs.readFile(path.join(TOKEN_DIR, accountFile), 'utf-8'));
    oauth2Client.setCredentials(tokens);
    try {
      const { data } = await youtube.commentThreads.insert({ part: 'snippet', requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: commentText } } } } });
      console.log(`✅ [${accountFile}] 댓글 성공: ID=${data.id}`);
    } catch (err) {
      console.error(`❌ [${accountFile}] 댓글 오류:`, err.errors || err);
    }
    if (useDelay && i < pairs.length - 1) {
      console.log(`⏱ ${delayMs/1000}s 대기중...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
};

// 3) 댓글 좋아요 누르기 (프로필 기반 자동화)
const likeComment = async () => {
  const profiles = await fs.readdir(PROFILE_DIR);
  if (!profiles.length) return console.log('⚠️ 저장된 프로필이 없습니다. 먼저 계정을 인증하세요.');

  const { profile, commentUrl } = await inquirer.prompt([
    { type: 'list', name: 'profile', message: '계정 선택:', choices: profiles },
    { name: 'commentUrl', message: '좋아요 누를 댓글 페이지 URL:' }
  ]);
  const profileDir = path.join(PROFILE_DIR, profile);
  const browser = await puppeteer.launch(getPuppeteerOptions(profileDir));
  const page = await browser.newPage();
  await page.goto(commentUrl, { waitUntil: 'networkidle2' });
  await page.waitForSelector('ytd-comment-action-buttons-renderer #like-button');
  await page.evaluate(() => document.querySelector('ytd-comment-action-buttons-renderer #like-button').click());
  console.log(`✅ [${profile}] 좋아요 클릭 완료`);
  await browser.close();
};

// 메인 실행
await fs.mkdir(TOKEN_DIR, { recursive: true });
await fs.mkdir(PROFILE_DIR, { recursive: true });
const main = async () => {
  while (true) {
    const { action } = await inquirer.prompt({ type: 'list', name: 'action', message: '원하는 작업 선택:', choices: ['계정 인증', '댓글 작성', '댓글 좋아요', '종료'] });
    if (action === '계정 인증') await authorizeAccount();
    else if (action === '댓글 작성') await postComment();
    else if (action === '댓글 좋아요') await likeComment();
    else break;
  }
  console.log('프로그램 종료');
};
await main();