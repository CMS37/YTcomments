#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import inquirer from 'inquirer';
import open from 'open';

// YouTube API 스코프
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

// 경로
const CREDENTIALS_PATH = path.resolve('credentials.json');
const TOKEN_DIR       = path.resolve('tokens');

// credentials.json 로드 및 OAuth 클라이언트 생성
const { client_id, client_secret, redirect_uris } =
  JSON.parse(await fs.readFile(CREDENTIALS_PATH, 'utf-8')).installed;
const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

// YouTube ID 또는 URL 파싱
const parseVideoId = input => {
  const idPattern = /(?:v=|\/)([A-Za-z0-9_-]{11})(?:[&\/]|$)/;
  const match = input.match(idPattern);
  if (match) return match[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  throw new Error('유효한 YouTube 영상 ID 또는 URL을 입력하세요.');
};

// 계정 인증 및 토큰 발급
const authorizeAccount = async () => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log(`
1) 다음 URL을 브라우저에서 열어 로그인하세요:
${authUrl}
`);
  await open(authUrl);

  const { code } = await inquirer.prompt({
    name: 'code',
    message: '2) 브라우저에서 받은 코드를 입력하세요:'
  });

  const { tokens } = await oauth2Client.getToken(code.trim());
  oauth2Client.setCredentials(tokens);

  const { name: accountName } = await inquirer.prompt({
    name: 'name',
    message: '3) 이 토큰을 저장할 계정 이름을 입력하세요:'
  });

  await fs.writeFile(
    path.join(TOKEN_DIR, `${accountName}.json`),
    JSON.stringify(tokens, null, 2)
  );
  console.log(`✔ tokens/${accountName}.json 에 저장되었습니다.`);
};

// 댓글 작성
const postComment = async () => {
  const files = (await fs.readdir(TOKEN_DIR)).filter(f => f.endsWith('.json'));
  if (!files.length) {
    console.log('⚠️ 인증된 계정이 없습니다. 먼저 계정을 인증하세요.');
    return;
  }

  const { accountFile } = await inquirer.prompt({
    type: 'list',
    name: 'accountFile',
    message: '어떤 계정으로 댓글을 달까요?',
    choices: files
  });

  const tokens = JSON.parse(
    await fs.readFile(path.join(TOKEN_DIR, accountFile), 'utf-8')
  );
  oauth2Client.setCredentials(tokens);

  const { rawInput, commentText } = await inquirer.prompt([
    { name: 'rawInput',    message: 'URL 또는 ID 입력:' },
    { name: 'commentText', message: '댓글 내용 입력:' }
  ]);

  let videoId;
  try {
    videoId = parseVideoId(rawInput.trim());
  } catch (err) {
    console.error(err.message);
    return;
  }

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });
  try {
    const { data } = await youtube.commentThreads.insert({
      part: 'snippet',
      requestBody: {
        snippet: { videoId, topLevelComment: { snippet: { textOriginal: commentText } } }
      }
    });
    console.log(`✅ 댓글 게시 성공: ID=${data.id}`);
  } catch (err) {
    console.error('댓글 게시 오류:', err.errors || err);
  }
};

// 메인 실행
const main = async () => {
  await fs.mkdir(TOKEN_DIR, { recursive: true });

  const { action } = await inquirer.prompt({
    type: 'list',
    name: 'action',
    message: '원하는 작업을 선택하세요:',
    choices: [
      { name: '계정 인증하기', value: 'auth' },
      { name: '댓글 작성하기', value: 'comment' },
      { name: '종료',          value: 'exit' }
    ]
  });

  if (action === 'auth')   await authorizeAccount();
  if (action === 'comment') await postComment();
  if (action !== 'exit')    return main();

  console.log('프로그램을 종료합니다.');
};

await main();

// .gitignore
## Node modules
node_modules/

## Tokens & credentials
credentials.json
tokens/

## Env files
.env

## OS
.DS_Store
Thumbs.db
