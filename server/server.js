import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import moment from 'moment-timezone';
// import Redis from 'ioredis';
import redisClient from '../utils/redis.js';
// es module 환경에서 디렉토리 경로 가져오기
import path, { normalize } from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const server = http.createServer(app);
const io = new Server(server);
// 데이터 저장소 redis 설정 port: 6379

// 채팅 로깅
// import axios from 'axios'; 
// import fs from 'fs-extra';
import { saveChatLog } from '../utils/chatLogger.js';
import { report } from 'process';
// import { time } from 'console';
const LOGGER_SERVER_URL = 'http://localhost:4000/log'; // 로깅 서버 URL

// 정적 파일 경로 추가
app.use('/node_modules', express.static(path.join(__dirname, '../node_modules'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// 기존 라우터
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json()); // JSON 데이터 파싱을 위한 미들웨어

/*
 * 신고 처리 API: 클라이언트가 신고 데이터를 전송하면 이를 처리
 */

app.get('/admin=:id&:password/reports', (req, res) => {
    const { id, password } = req.params;

    if (id !== 'master' || password !== 'nulm1004') {
        return res.status(403).send('잘못된 접근입니다.');
    }

    // reportList.html 파일 경로를 제공
    res.sendFile(path.join(__dirname, '../public', 'reportList.html'));
});


app.get('/api/reports', (req, res) => {
    // redis 데이터 조회
    redisClient.keys('reports:*', (err, keys) => {
        if (err) {
            console.error('[redis] 키 조회 오류: ', err);
            return res.status(500).send('서버 오류');
        }

        const reports = [];
        let processKeys = 0;

        keys.forEach((key) => {
            redisClient.lrange(key, 0, -1, (err, userReports) => {
                if (err) {
                    console.error('[redis] 리스트 조회오류:', err);
                } else {
                    userReports.forEach((report) => {
                        const parsed = JSON.parse(report);
                        const ip = key.split(':')[1];

                        // 동일한 IP가 이미 있으면 정보 추가, 없으면 새로 추가
                        const existingReport = reports.find(r => r.ip === ip);
                        if (existingReport) {
                            existingReport.roomId += `\n${parsed.roomId}`;
                            existingReport.reason += `\n${parsed.reason}`;
                            existingReport.time += `\n${parsed.time}`;
                        } else {
                            reports.push({
                                ip: ip,
                                roomId: parsed.roomId,
                                reason: parsed.reason,
                                time: parsed.time
                            });
                        }
                    });
                }  
                processKeys++;
                if (processKeys === keys.length) {
                    res.json(reports);
                }
            });
        });

        if(keys.length === 0) {
            res.json([]);
        }
    });
});


const PORT = process.env.PORT || 3000;
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});

const waitingUsers = new Map(); //대기열 관리
const activeChats = new Map(); //활성채팅
const MAX_REPORT = 3; // 최대 리포트 수 

// 세션 타임아웃 설정
// const SESSION_DURATION = 1 * 60 * 1000; //test time 
const SESSION_DURATION = 8 * 60 * 60 * 1000; //8시간
const userSessions = new Map(); // 사용자 세션 상태 관리


// IPv4 반환
function normalizeIP(ip) {
    // (IPv6 localhost) 변환
    if (ip === "::1") {
        return "127.0.0.1";
    }
    // IPv6에서 IPv4 주소 추출
    if (ip.startsWith("::ffff:")) {
        return ip.replace("::ffff:", "");
    }
    return ip;
}

io.on('connection', async (socket) => {
    socket.entered=false;

    /* enter버튼 클릭시 입장대기열 추가 */
    socket.on('enter-state', async() => {

        if(!socket.entered) {
            socket.entered = true; // 버튼을 눌렀을때만 상태변경 
            // 유저
            socket.userIP = normalizeIP(socket.handshake.address); // IPv4형식으로 반환
            socket.nickname = `User_${Math.floor(Math.random() * 1000)}`;
            console.log(`[SERVER] NEW USER CONNECTED! : ${socket.nickname} [IP:${socket.userIP}]`);

            // 클라이언트에 닉네임 전송
            socket.emit('set-nickname', socket.nickname);

            //세션 설정
            const session = {
                lastActivity : Date.now(),
                background: false, 
                // timeout: setTimeout(()=>handleSessionTimeout(socket.id), SESSION_DURATION),
                timeout: setTimeout(()=>handleSessionTimeout(socket), SESSION_DURATION),
            };

           userSessions.set(socket.id, session);

            // 세션 set 확인용
            for (const [socketId, session] of userSessions.entries()) {
                console.log(`[server] Session for ${socket.id}:`);
                console.log(`  Last Activity: ${new Date(session.lastActivity).toISOString()}`);
                console.log(`  Background: ${session.background}`);
                console.log(`  Timeout: ${session.timeout}`);
            }

            


            addToWaitingUsers(socket); //대기열 추가

            // 대기 상태 메시지 전송
            await delay(1000);
            socket.emit('wait-state', {
                message: "상대 유저를 찾는 중입니다. \n 잠시만 기다려 주세요.",
                messageType: 'system'
            });
            // 대기열 추가된 유저들과 랜덤 매칭
            matchUsers();
        } else {
            console.log(`[server] ${socket.nickname} ALREADY ENTERED`);
        }
    });


    // 메시지 전송 처리
    socket.on('chat-message', async (msg) => {
        const session = userSessions.get(socket.id);
        const chatRoom = getChatRoomByUser(socket.id);

        if (!session || !chatRoom) {
            const errorMessage = !session ? '세션 정보를 가져올 수 없습니다.'
                                          : '채팅 정보를 가져올 수 없습니다.';
            console.log(`[server] ${errorMessage}`);
            return;
        } 
        
        const { room, roomId } = chatRoom;
    
        if (!room || !room.users) {
            console.error(`[server] Room or users not found for roomId: ${roomId}`);
            return;
        }
    

        room.users.forEach(user => {

            if (!user.socket || !user.socket.connected) {
                console.warn(`[server] Socket is not connected for user: ${user.nickname}`);
                return;
            }
    
            const messageType = user.id === socket.id ? 'sender' : 'receiver';
             // 메시지 전송 처리
            user.socket.emit('chat-message', {
                sender: socket.nickname,
                message: msg,
                messageType,
            });
            console.log(`[server] Message sent from ${socket.nickname} to ${user.nickname}, type: ${messageType}`);

        });
    
        // 로그 저장
        const logData = {
            nickname: socket.nickname,
            userIP: socket.userIP,
            message: msg,
            timestamp: new Date(),
        };
    
        try {
            await saveChatLog(roomId, logData);
            console.log(`[server] Log saved for room ${roomId}`);
        } catch (error) {
            console.error(`[server] Log failed to save for room ${roomId}: ${error.message}`);
        }
    });

    // 세션 상태에 따른 처리
    socket.on('session-action', (action) => {
        const session = userSessions.get(socket.id);
        console.log(`sessoion get: ${socket.id}:`, session);
        

        if (action === 'reset') {
            initializeSession(socket);
            console.log(`${socket.id} session reset`);
        } else if (action === 'background') {
            // 백그라운드 상태로 전환
            if (session) {
                if (session.timeout) {
                    clearTimeout(session.timeout); // 기존 타임아웃 제거
                }

                session.background = true; // 백그라운드 상태 설정
                session.timeout = setTimeout(() => handleSessionTimeout(socket), SESSION_DURATION); // 새로운 타임아웃 설정
                userSessions.set(socket.id, session); // 갱신된 세션 저장

                console.log(`[server] ${socket.id} set to background with timeout of ${SESSION_DURATION / 1000}s.`);
            }
        }
    }); 

    // 재연결 (restartBtn 클릭 이벤트 처리)
    socket.on('restart-connect', () => {
        // console.log(`[server] ${socket.userIP}님이 재연결을 요청하였습니다.`);
        const chatRoom = getChatRoomByUser(socket.id);
        if (chatRoom) {
            const { roomId , room } = chatRoom;
            
            const partner = room.users.find( user => user.id !== socket.id);
            if (partner) {
                if(partner.socket.connected) {
                    addToWaitingUsers(partner.socket);
                    // 상대방에게 연결종료 알림
                    partner.socket.emit('chat-end', {
                        message: '상대방이 연결을 종료하였습니다. \n 새로운 유저를 찾습니다.',
                        messageType: 'system'
                    });
                }
            }
            //방삭제
            removeChatRoom(roomId);
        }
         // 재연결 메시지 알림
         socket.emit('wait-state', {
            message: '연결을 종료하여 새로운 유저를 찾습니다.',
            messageType: 'system'
        });
        setTimeout(()=>{
             //본인을 대기열에 추가
            addToWaitingUsers(socket);
             // 재연결 메시지 알림
            socket.emit('wait-state', {
                message: '잠시만 기다려 주세요.',
                messageType: 'system'
            });
            // 새로운 매칭 시도
            matchUsers();
        }, 5000); //5초후 재연결 시도
    });

    // 연결 종료 (시스템/네트워크 종료시) 
    socket.on('disconnect', ()=>{
        console.log(`[server] ${socket.nickname}[${socket.userIP}]서버 연결 종료.`);
        if (userSessions.has(socket.id)) {
            // io.emit('server-disconnect', { message: '상대방이 연결을 종료했습니다.' });
            handleDisconnection(socket.id);
            userSessions.delete(socket.id);
        } else {
            console.log(`[server] Session for ${socket.id} already cleared.`);
        }
    });

    // 연결 종료 (유저 요청)
    socket.on('user-disconnect', () => {
        console.log(`[server] ${socket.nickname}[${socket.userIP}]유저요청 연결 종료. `);
        handleDisconnection(socket.id);
    });

    // 연결 종료 (신고)
    socket.on('report-disconnect', (reportData) => {
        const { reporter, partner, reason, roomId } = reportData;

        const partnerSocket = io.sockets.sockets.get(partner.id);
        const partnerIP = partnerSocket ? partnerSocket.userIP : 'unknown';
        
        const reporterSocket = io.sockets.sockets.get(reporter.id);
        const reporterIP = reporterSocket.userIP || 'unknown';

        console.log(`[server] ${reporterIP}님이 ${partnerIP}님을 신고: `, reason);

        saveReport(partnerIP, reason, roomId);

        // MAX_REPORT 확인
        checkMaxReports(partnerIP, (isMaxReportExceeded) => {
            if (isMaxReportExceeded) {
                partnerSocket.emit('report-redirect', { message: `${partnerIP}님은 신고 한도를 초과하여 접근이 제한됩니다. `});
                // 연결종료 //세션삭제
                partnerSocket.disconnect(true); 
                
            } else {
                setTimeout(() => {
                    addToWaitingUsers(partnerSocket);
                    console.log(`[server] ${partnerIP}님을 3초후 대기열에 추가합니다.`);
                    matchUsers();
                }, 3000);
            }
        });
        
        // 신고자 메시지 처리
        reporterSocket.emit('chat-end', {
            message: '신고가 접수되어 연결을 종료합니다.',
            messageType: 'system'
        });
        reporterSocket.disconnect(true); 
        
        // 신고 대상 메시지 처리
        if (partnerSocket) {
            partnerSocket.emit('chat-end', {
                message: '신고로 인해 연결이 종료되었습니다.',
                messageType: 'system',
            });
            partnerSocket.disconnect(true);

        }
        
        // 신고자 대기열 추가 및 즉시 매칭
        addToWaitingUsers(reporterSocket);
        console.log(`[server] ${reporterSocket.userIP}님을 대기열에 즉시 추가합니다.`);
        matchUsers();


        // 서버 응답 전송
        reporterSocket.emit('report-response', { success: true, message: '신고가 처리되었습니다.' });
      
    })



}); /* io.on connection */


/* function */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



// 세션 초기화
function initializeSession(socket) {
    let session = userSessions.get(socket.id);

    if (!session) {
        console.log(`[socket.id] no session found for: ${socket.id}`)
        session = {
            lastActivity: Date.now(),
            background: false,
            timeout: null,
        };
    }
    session.lastActivity = Date.now();
    session.background = false;

    if (session.timeout) {
        clearTimeout(session.timeout);
    }

    session.timeout = setTimeout(()=> handleSessionTimeout(socket), SESSION_DURATION);
    // session.timeout = setTimeout(()=> handleSessionTimeout(socket.id), SESSION_DURATION);
    userSessions.set(socket.id, session);
    console.log(`[server] SESSION initialized for ${socket.id}`);
}


//세션 만료
async function handleSessionTimeout(socket){
    if (!socket || !socket.id) {
        console.error(`[server] Invalid socket object in handleSessionTimeout`);
        return;
    }

    const session = userSessions.get(socket.id);

    if (!session) return;
    
    const timeSinceActivity = Date.now() - session.lastActivity;
    if (!session.background && timeSinceActivity < SESSION_DURATION ){
        console.warn(`[server] Session for ${socket.id} is still active.`);
        return;
    }

    userSessions.delete(socket.id); // 세션 삭제
    removeFromWaitingQueue(socket.id); // 대기열 제거
    console.log(`[server] Session expired for socketId: ${socket.id}`);

    // 상대방 소켓도 연결종료
    const chatRoom = getChatRoomByUser(socket.id);
    if (chatRoom) {
        const { room, roomId } = chatRoom;
        const partner = room.users.find( user => user.id !== socket.id);

        if (partner) {
            const partnerSocket = partner.socket;
            if (partnerSocket.connected) {
                partnerSocket.emit('chat-end', {
                   message: '상대방의 세션이 만료되어 연결이 종료됩니다. \n 새로운 유저를 찾습니다.',
                   messageType: 'system'
                });

                addToWaitingUsers(partnerSocket);
                console.log(`[server] ${partnerSocket.nickname}님을 대기열에 추가합니다.`);
                await matchUsers();
            }
        } 

        removeChatRoom(roomId);
        console.log(`[server] Removed chat room: ${chatRoom.roomId}`);
    }

    if (socket.connected) {
        console.log(`[server] ${socket.id} about session expiration.`);
        socket.emit('session-expired', {
            message: '세션이 만료되었습니다. 다시 접속해 주세요.'
        });
        socket.disconnect(true);
    }
}

// 신고 데이터 저장
function saveReport(userIP, reason, roomId) {
    const timestamp = moment().format('YY-MM-DD HH:mm:ss');
    const reportData = { userIP, reason, roomId, time: timestamp };

    redisClient.lpush( `reports: ${userIP}`, JSON.stringify(reportData), (err)=> {
        if(err) {
            console.error('[server] 신고데이터 저장 오류: ', err);
        } else {
            console.log('[server] 신고 데이터 저장: ', reportData);
        }
    });
}

// 신고 - MAX_REPORT 초과 확인
function checkMaxReports(userIP, callback) {
    redisClient.llen(`report: ${userIP}`, (err, count)=>{
        if (err) {
            console.error('[redis] 조회 오류:', err);
            callback(false);
        } else {
            callback(count >= MAX_REPORT);
        }
    });
}

// 대기열 관리
function addToWaitingUsers(socket){

    if (!socket.entered) {
        console.log(`[server] ${socket.id} attempted to join without entering. Ignoring.`);
        return false; // 사용자가 입장 버튼을 누르지 않았음
    }

    if (!waitingUsers.has(socket.id)) {
        waitingUsers.set(socket.id, { socket, nickname: socket.nickname, userIP: socket.userIP });
        console.log(`[server] [IP: ${socket.userIP}]님이 대기열에 추가되었습니다.`);
    } else {
        console.log(`[server] [IP: ${socket.userIP}]님은 이미 대기중입니다.`);
    }
    // console.trace(`[server-debug] addToWaitingUsers called for ${socket.id} [${socket.nickname}]`)
    return true;
};

// 대기열 삭제
function removeFromWaitingQueue(socketId) {
    if (waitingUsers.has(socketId)) {
        waitingUsers.delete(socketId);
        console.log(`[server] Removed ${socketId} from waiting queue.`);
    } else {
        console.log(`[server] ${socketId} not found in waiting queue.`);
    }
}

// 유저매칭 
function getNextUsersForMatch() {
    const users = Array.from(waitingUsers.values());
    console.log(`[server] Attempting to match users. Current queue:`, Array.from(waitingUsers.keys()));
    
    if (users.length >= 2) {
        const selectedUsers = users.slice(0, 2);
        console.log(`[server] Matched users:`, selectedUsers.map(user => user.nickname));
        selectedUsers.forEach(user => waitingUsers.delete(user.socket.id));
        return selectedUsers;
    }
    console.log(`[server] Not enough users to match.`);
    return null;
}

// active chat 채팅 방 관리 
function createChatRoom(user1, user2) {
    const roomId = `${user1.socket.id}#${user2.socket.id}`;

    // 활성 채팅 목록에 추가
    activeChats.set(roomId, {
        roomId,
        users: [
            { id: user1.socket.id, nickname: user1.socket.nickname, socket: user1.socket, partner: user2.socket.id },
            { id: user2.socket.id, nickname: user2.socket.nickname, socket: user2.socket, partner: user1.socket.id }
        ],
    });

    user1.socket.join(roomId);
    user2.socket.join(roomId);
    // console.log(`[server] ${user1.nickname}님과 ${user2.nickname}님의 채팅방 생성: ${roomId}`);
    console.log(`[server] ${user1.nickname} and ${user2.nickname} - chatRoom: ${roomId}`);
    return roomId;
}

// 채팅방 찾기
function getChatRoomByUser(socketId){
    for (const [roomId, room] of activeChats.entries()) {
        if (room.users.some( user => user.id === socketId )) {
            return { room, roomId };
        }    
    }
    return null;
};

// 채팅방 비활성화
function removeChatRoom(roomId) {
    activeChats.delete(roomId);
}

// 유저 매칭
async function matchUsers() {

    const users = getNextUsersForMatch();
    
    if (users) {
        const [user1, user2] = users;
        const roomId = createChatRoom(user1, user2);
        await notifyChatReady(user1, user2, roomId);
        console.log(`[server] Successfully matched users: ${user1.nickname} and ${user2.nickname} in room: ${roomId}`);
    } else {
        console.log(`[server] Not enough users to match.`);
    }
};


// 채팅 준비 알림
async function notifyChatReady(user1, user2, roomId) {
    const chatReadyPayload = (user, partner) => ({
        roomId,
        users: [
            { id: user.socket.id, nickname: user.socket.nickname, userIP:user.socket.userIP },
            { id: partner.socket.id, nickname: partner.socket.nickname, userIP:partner.socket.userIP }
        ],
        message: `${partner.nickname}님과 채팅을 시작합니다.`,
        messageType: 'system'
    });
    await delay(1000);
    user1.socket.emit('chat-ready', chatReadyPayload(user1, user2));
    user2.socket.emit('chat-ready', chatReadyPayload(user2, user1));

    // 방 전체에 경고 메시지 전송
    await delay(1500);
    io.to(roomId).emit('warning-message', {
        message: "금전 또는 개인정보를 요구받을 경우 신고해 주시기 바랍니다. 운영정책을 위반한 메시지로 신고 접수 시 이용에 제한이 있을 수 있습니다.",
        messageType: 'system'
    });
}

function handleDisconnection(socketId) {
    const chatRoom = getChatRoomByUser(socketId);

    if (chatRoom) {
        // const { roomId, users } = chatRoom;
        const { roomId, room } = chatRoom;
       
        if (!room || !room.users) {
            console.error(`[server] users 배열을 찾을 수 없습니다.`);
            return;
        }

        const partner = room.users.find(user => user.id !== socketId);

        if (partner && partner.socket && partner.socket.connected) {
            // if (!waitingUsers.has(partner.socket.id)) {
            addToWaitingUsers(partner.socket);
            //console.log(`${partner.nickname} 대기열 추가`);

            // 상대방에게 연결 종료 알림
            partner.socket.emit('chat-end', {
                message: '상대방이 연결을 종료하였습니다. \n 재연결을 위해 잠시만 기다려 주세요.',
                messageType: 'system',
            });
        // }
        }
        removeChatRoom(roomId);
    }
    if (waitingUsers.has(socketId)) {
        removeFromWaitingQueue(socketId);
        console.log(` 대기열에서 제거 : ${socketId}`);
    }
    console.log(`[server] 연결 종료 처리 완료: ${socketId}`);
}