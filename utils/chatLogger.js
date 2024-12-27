import fs from 'fs-extra';
import path from 'path';
import moment from 'moment-timezone';

// 저장 경로를 로컬의 경로로 설정
// const BASE_LOG_DIR = path.join('/Users/yijiyeong/Documents/nulm');
const BASE_LOG_DIR = path.join('/home/ec2-user/nulm-logs');

// 특수 문자 처리 함수
const sanitizeFileName = (roomId) => {
  const sanitized = roomId.replace(/[^a-zA-Z0-9-_]/g, '_');
  // console.log(`[Logger] Sanitized roomId: ${sanitized}`); // 디버깅용
  return sanitized;
};

// 날짜별 폴더 및 파일 경로 생성 함수
const getLogFilePath = (roomId) => {
    const now = new Date();
    const year = now.getFullYear().toString(); // 숫자를 문자열로 변환
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const sanitizedRoomId = sanitizeFileName(roomId); // 특수 문자 처리
    const fileName = `${sanitizedRoomId}.txt`; // 파일 이름 생성
    // 파일 경로 생성
    const filePath = path.join(BASE_LOG_DIR, year, month, day, fileName);
    // console.log(`[Logger] Generated file path: ${filePath}`); // 디버깅용 경로 출력
    return filePath;
  };
  

// 로그 메시지 포맷팅 함수
const formatLogMessage = ({ nickname, userIP, message, timestamp }) => {
  const formattedTimestamp = moment(timestamp).tz("Asia/Seoul").format("YY-MM-DD HH:mm:ss");
  const logMessage = `${nickname}[IP: ${userIP}]: ${message} -${formattedTimestamp}\n`;
  // console.log(`[Logger] Formatted log message: ${logMessage.trim()}`); // 디버깅용
  return logMessage;
};

// 메시지 저장 함수
export const saveChatLog = async (roomId, logData) => {
  const filePath = getLogFilePath(roomId);
  const logMessage = formatLogMessage(logData);
  try {
    await fs.ensureFile(filePath); // 경로가 없으면 생성
    // console.log(`[Logger] Ensured file exists: ${filePath}`); // 디버깅용
    await fs.appendFile(filePath, logMessage); // 로그 추가
    // console.log(`[Logger] Log saved: ${logMessage.trim()}`);
  } catch (error) {
    console.error(`[Logger] Error saving log for room "${roomId}" at "${filePath}": ${error.message}`);
  }
};
