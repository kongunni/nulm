import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import moment from 'moment-timezone';
import Redis from 'ioredis';
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
import axios from 'axios'; 
import fs from 'fs-extra';
import { saveChatLog } from '../utils/chatLogger.js';
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

// Redis 연동 테스트
// app.get('/test', async (req, res) => {
//     try {
//         // Redis에 데이터 저장
//         await redisClient.set('testKey', 'testValue');
//         const value = await redisClient.get('testKey');

//         res.send({ success: true, value }); // Redis에서 가져온 값 반환
//     } catch (err) {
//         console.error('Redis error:', err);
//         res.status(500).send({ success: false, error: err.message });
//     }
// });


/*
 * 신고 처리 API: 클라이언트가 신고 데이터를 전송하면 이를 처리
 */

const MAX_REPORT = 100; // 최대 리포트 수 
app.post('/chat/report', express.json(), async (req, res) => {
    const { roomId, partnerNickname, partnerIP, reasons } = req.body;

    if (!roomId || !partnerNickname || !partnerIP || !reasons) {
        return res.status(400).send({ success: false, message: '신고 데이터가 올바르지 않습니다.' });
    }
    console.log(`[server] 신고 접수 - 닉네임: ${partnerNickname}, IP: ${partnerIP}, 사유: ${reasons.join(', ')}`);

    const reasonMapping = {
        "스팸": "spam", 
        "비속어": "vulgarism", 
        "금전요구": "bankFraud",
        "기타": "etc"
    }

    const reasonsEng = reasons.map(reason => reasonMapping[reason] || "unknown");

    try {
        const reportKey = `banned:${partnerIP}`;
        const timestamp = moment().tz("Asia/Seoul").format("YY-MM-DD HH:mm:ss");
       
       const keyTypes = await redisClient.type(reportKey);
       if (keyTypes !== 'hash' && keyTypes !== 'none') {
        console.error(`[server] Redis 키 타입이 올바르지 않습니다: ${keyType}. 키를 초기화합니다.`);
        await redisClient.del(reportKey); // 잘못된 타입의 키 삭제
       }
       
        // 기존 데이터 가져오기
        const currentData = await redisClient.hgetall(reportKey);
        const currentHistory = currentData.history ? JSON.parse(currentData.history) : [];
        const reportCount = (currentData.reportCount ? parseInt(currentData.reportCount) : 0) + 1;
       
        // 새로운 신고 정보 추가
        const newReport = {
            nickname: partnerNickname || "Unknown",
            reason: reasonsEng.join(', '),
            timestamp: timestamp,
        };
        currentHistory.push(newReport);
     
        const keyType = await redisClient.type(reportKey);
        if (keyType !== 'hash' && keyType !== 'none') {
            console.error(`[server] Redis 키 타입이 올바르지 않습니다: ${keyType}. 키를 초기화합니다.`);
            await redisClient.del(reportKey); // 잘못된 타입의 키 삭제
        }

        await redisClient.hset(reportKey, {
            reportCount: reportCount.toString(),
            userIP: partnerIP,
            history: JSON.stringify(currentHistory),
        });



        // MAX_REPORT 초과 여부 확인
        const isBanned = reportCount >= MAX_REPORT;
        
        if (isBanned) {
            console.log(`[server] MAX_REPORT 초과 유저(IP: ${partnerIP})는 더 이상 nulm을 이용할 수 없습니다. REPORT: ${reportCount}`);
        }

        // 현재 채팅방 가져오기
        const chatRoom = activeChats.get(roomId);
        if (chatRoom && chatRoom.users.length === 2 ) {
        // if (chatRoom) {
            const [user1, user2] = chatRoom.users;
            // 신고자와 신고대상 구분
            const reporterSocket = user1.id === req.body.reporterId ? user1.socket : user2.socket;
            const reportedSocket = user1.id === req.body.reporterId ? user2.socket : user1.socket;
            
            await handleReport(roomId, reporterSocket, reportedSocket, reasons);
        }

        res.send({
            success: true,
            message: '신고가 접수되었습니다.',
            reportCount: reportCount,
            banned: isBanned,
        });

    } catch (error) {
        console.error(`[server] 신고 처리 중 오류 발생: ${error.message}`);
        res.status(500).send({ success: false, message: '신고 처리 중 오류가 발생했습니다.' });
    }
});
             

async function handleReport(roomId, reporterSocket, reportedSocket, reasons) {
    const reporterIP = reporterSocket.userIP; // 신고자
    const reportedIP = reportedSocket.userIP; // 신고 대상
    const reportedNickname = reportedSocket.nickname;
    // console.log(`[server] report ${reporterIP}-> ${reportedNickname}[${reportedIP}]`);

    try {
        const reportKey = `banned:${reportedIP}`;
        const currentReportData = await redisClient.hgetall(reportKey);
       // let reportCount = currentReportData.reportCount ? parseInt(currentReportData.reportCount) : 0;
       let reportCount = currentReportData?.reportCount ? parseInt(currentReportData.reportCount, 10) : 0;
        // 신고 횟수 증가
        reportCount += 1;

        // 기존 신고 사유와 새로운 사유 병합
        // const updatedReasons = currentReportData.reason
        //     ? `${currentReportData.reason}, ${reasons.join(', ')}`
        //     : reasons.join(', ');

        const existingReasons = currentReportData?.reason
            ? currentReportData.reason.split(', ')
            : [];
        const updatedReasons = [...new Set([...existingReasons, ...reasons])].join(', ');


        // Redis에 업데이트
        await redisClient.hset(reportKey, {
            reportCount: reportCount.toString(),
            userIP: reportedIP,
            nickname: reportedNickname,
            reason: updatedReasons,
            timestamp: new Date().toISOString(),
        });

        const isBanned = reportCount >= MAX_REPORT;

        if (isBanned) { //리포트 수 넘은 사용자 연결종료
            reportedSocket.disconnect();
            //  console.log(`[server] 신고된 사용자 차단 처리 - IP: ${reportedIP}, 신고 수: ${reportCount}`);
        } else {
            reportedSocket.emit('chat-end', { // 신고대상
                message: '연결이 종료되었습니다.',
                messageType: 'system',
            });
        }

        // 신고자
        reporterSocket.emit('chat-end', {
            message: '연결이 종료되었습니다.',
            messageType: 'system',
        });

        // 대기열 처리 및 새로운 매칭 시도
        setTimeout(() => {
            addToWaitingUsers(reporterSocket);
            reporterSocket.emit('wait-state', {
                message: '잠시만 기다려 주세요. \n 새로운 유저를 찾고 있습니다.',
                messageType: 'system',
            });

            if (!isBanned) {
                addToWaitingUsers(reportedSocket);
                reportedSocket.emit('wait-state', {
                    message: '잠시만 기다려 주세요. \n 새로운 유저를 찾고 있습니다.',
                    messageType: 'system',
                });
            }
            matchUsers();
        }, 5000);

    } catch (error) {
        console.error(`[server] 신고 처리 중 오류 발생: ${error.message}`);
    }
}


app.get('/admin/reports', async (req, res) => {
    try {
        const keys = await redisClient.keys('banned:*');
        const groupedReports = {};

        for (const key of keys) {
            const currentData = await redisClient.hgetall(key);
            const ip = currentData.userIP || key.split(':')[1];
            const history = currentData.history ? JSON.parse(currentData.history) : [];

            groupedReports[ip] = history.map((entry, index) => ({
                nickname: entry.nickname || 'Unknown', // 닉네임 기본값 설정
                reason: entry.reason || 'N/A',
                timestamp: entry.timestamp || 'N/A',
                count: index + 1,
            }));
        }

        const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Admin Reports</title>
            <style>
                table {
                    width: 100%;
                    border-collapse: collapse;
                }
                th, td {
                    border: 1px solid #ddd;
                    padding: 8px;
                    text-align: left;
                }
                th {
                    background-color: #f2f2f2;
                }
                .ip-cell {
                    vertical-align: middle;
                    text-align: center;
                }
            </style>
        </head>
        <body>
            <h1>Reported Users</h1>
            <table>
                <thead>
                    <tr>
                        <th>IP</th>
                        <th>Nickname</th>
                        <th>Reason</th>
                        <th>Timestamp</th>
                        <th>Count</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.entries(groupedReports)
                        .map(([ip, reports]) => {
                            return reports.map((report, index) => `
                                <tr>
                                    ${index === 0 ? `<td class="ip-cell" rowspan="${reports.length}">${ip}</td>` : ''}
                                    <td>${report.nickname}</td>
                                    <td>${report.reason}</td>
                                    <td>${report.timestamp}</td>
                                    <td>${report.count}</td>
                                </tr>
                            `).join('');
                        }).join('')}
                </tbody>
            </table>
        </body>
        </html>
        `;

        res.send(html);
    } catch (error) {
        console.error('[server] Admin report page error:', error.message);
        res.status(500).send('Internal Server Error');
    }
});


const PORT = process.env.PORT || 3000;
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});

/*
 * start
*/ 

// 변수
const waitingUsers = new Map(); //대기열 관리
const activeChats = new Map(); //활성채팅

// 세션 타임아웃 설정
const SESSION_DURATION = 1 * 60 * 1000; //test) 1분
// const SESSION_DURATION = 8 * 60 * 60 * 1000; //8시간
const userSessions = new Map(); // 사용자 세션 상태 관리


// IPv4 반환
function normalizeIP(ip) {
    // "::1" (IPv6 localhost) 변환
    if (ip === "::1") {
        return "127.0.0.1";
    }

    // IPv6에서 IPv4 주소 추출
    if (ip.startsWith("::ffff:")) {
        return ip.replace("::ffff:", "");
    }

    // 이미 IPv4 형식이면 그대로 반환
    return ip;
}

io.on('connection', async (socket) => {
    socket.entered=false;

    /* enter버튼 클릭시 입장대기열 추가 */
    socket.on('enter-state', async() => {

        if(!socket.entered) {
            socket.entered = true; // 버튼을 눌렀을때만 상태변경 
            // console.log('[server] client clicked enter-btn');
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
                timeout: setTimeout(()=>handleSessionTimeout(socket.id), SESSION_DURATION),
            };

           userSessions.set(socket.id, session);

            // 세션 set 확인용
            for (const [socketId, session] of userSessions.entries()) {
                console.log(`[server] Session for ${socket.id}:`);
                console.log(`  Last Activity: ${new Date(session.lastActivity).toISOString()}`);
                console.log(`  Background: ${session.background}`);
                console.log(`  Timeout: ${session.timeout}`);
            }

             /* 차단된 계정 접근 불가 */
            try {
                // 차단된 유저인지 확인
                const reportCount = await redisClient.get(`banned:${socket.userIP}`);
                if (reportCount && parseInt(reportCount) >= MAX_REPORT) {
                    console.log(`[server] banned: IP:${socket.userIP}] - 리포트 수: ${reportCount}`);
                    socket.emit('ban', { message: '서비스 이용 제한된 사용자입니다. 관리자에게 문의해 주세요.' });
                    socket.disconnect();
                    return;
                }
            } catch (error) {
                console.error(`[server] Redis 오류: ${error.message}`);
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
        if (action === 'reset') {
            //포그라운드 복귀시 초기화
            initializeSession(socket);
        } else if (action === 'background') {
            const session = userSessions.get(socket.id);
            if (session) {
                clearTimeout(session.timeout);
                session.background = true; 
                userSessions.set(socket.id, session);
                console.log(`[test] ${socket.nickname}[${socket.userIP}] is background`);
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

    // 신고 종료
    socket.on('report-disconnected', async ({ roomId }) => {
       
        const chatRoom = getChatRoomByUser(socket.id);
        if (!chatRoom) {
            socket.emit('system-message', { message: '신고 처리를 진행할 방이 없습니다.', messageType: 'error' });
            return;
        }

        const { room } = chatRoom;
        const partner = room.users.find((user) => user.id !== socket.id);

        if (!partner) {
            socket.emit('system-message', { message: '상대방 정보를 찾을 수 없습니다.', messageType: 'error' });
            return;
        }
        // 신고 처리
        handleReport(chatRoom.roomId, socket, partner.socket);
    });

    // 연결 종료 (시스템/네트워크 종료시) 
    socket.on('disconnect', ()=>{
        console.log(`[server] ${socket.nickname}[${socket.userIP}]서버 연결 종료.`);
        
        if (userSessions.has(socket.id)) {
            handleDisconnection(socket);
            userSessions.delete(socket.id);
        } else {
            console.log(`[server] Session for ${socket.id} already cleared.`);
        }
    });

    // 연결 종료 (유저 요청)
    socket.on('user-disconnect', () => {
        console.log(`[server] ${socket.nickname}[${socket.userIP}]유저요청 연결 종료. `);
        // 연결 종료 처리
        handleDisconnection(socket.id);
    });
}); /* io.on connection */


/* function */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}



// 세션 초기화
function initializeSession(socket) {
    // const expiryTime = Date.now() + SESSION_DURATION;
    let session = userSessions.get(socket.id);

    if (!session) {
        console.log(`[socket.id] no session found for: ${socket.id}`)
        // console.error(`[server] No session found for socketId: ${socket.id}. Initializing new session.`);
        session = {
            lastActivity: Date.now(),
            background: false,
            timeout: null,
        };
    }
    session.lastActivity = Date.now();
    session.background = false;
    clearTimeout(session.timeout);
    session.timeout = setTimeout(()=> handleSessionTimeout(socket.id), SESSION_DURATION);
    userSessions.set(socket.id, session);
    console.log(`[server] SESSION initialized for ${socket.id}`);
}


//세션 만료
function handleSessionTimeout(socket) {

    if (!socket || !socket.id) {
        console.error(`[server] Invalid socket object in handleSessionTimeout`);
        return;
    }

    let session = userSessions.get(socket.id);
    if (!session) return;

    // 세션 삭제
    userSessions.delete(socket.id);

    // 대기열에서 제거
    removeFromWaitingQueue(socket.id);
    console.log(`[server] Session expired for socketId: ${socket.id}`);

    // 소켓에 만료 알림 및 연결 종료
    
    if (socket.connected) {
        socket.emit('session-expired', { message: '세션이 만료되었습니다. 다시 접속해 주세요.' });
        
        if (socket.entered) {
            console.log(`[server] Removing user ${socket.id} from waiting queue.`);
        }
        
        socket.disconnect(true);
    } else {
        console.error(`[server] No active socket found for socketId: ${socket.id}`);
    }
    
    // 소켓에 만료 알림 및 연결 종료
    // const currentSocket = io.sockets.sockets.get(socket.id);
    // if (currentSocket) {
    //     currentSocket.emit('session-expired', { message: '세션이 만료되었습니다. 다시 접속해 주세요.' });

    //     if (currentSocket.entered) {
    //         console.log(`[server] Removing user ${socketId} from waiting queue.`);
    //     }

    //     currentSocket.disconnect(true);
    // } else {
    //     console.error(`[server] No active socket found for socketId: ${socketId}`);
    // }
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
    // for (const [roomId, room] of activeChats) {
    //     if (room && Array.isArray(room.users)) {
    //         const user = room.users.find(user => user.id === socketId);
    //         if (user) {
    //             return {roomId, room};
    //         }
    //     }
    //     return null;
    // }
};

// 채팅방 비활성화
function removeChatRoom(roomId) {
    activeChats.delete(roomId);
}

// 유저 매칭
// 이전코드
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

// partner - receiver sender 구분용
// function getPartnerSocket(socketId) {
//     for (const [roomId, room] of activeChats) {
//         const user = room.users.find(user => user.id === socketId);
//         if (user) {
//             const partnerId = user.partner;
//             // console.log(`[server] Partner socket ID for ${socketId} is ${partnerId}`);
//             return io.sockets.sockets.get(partnerId); // 상대방의 소켓 객체 반환
//         }
//     }
//     console.log(`[server] No partner found for socket ID: ${socketId}`);
//     return null;
// }

// 연결 종료
// function handleDisconnection(socketId) {
//     const chatRoom = getChatRoomByUser(socketId);

//     if (chatRoom) {
//         const { roomId, room } = chatRoom;


//         // 상대방 찾기
//         const partner = room.users.find(user => user.id !== socketId);

//         if (partner && partner.socket.entered && partner.socket.connected) {
//             // 대기열 중복 추가 방지
//             if (!waitingUsers.has(partner.socket.id)) {
//                 const partnerSession = userSessions.get(partner.socket.id);
//                 if (partnerSession) {
//                     console.log(`[server] ${partner.nickname}[${partner.userIP}]를 대기열에 다시 추가합니다.`);
//                     addToWaitingUsers(partner.socket);

//                     // 상대방에게 연결 종료 알림
//                     partner.socket.emit('chat-end', {
//                         message: '상대방이 연결을 종료하였습니다. \n 재연결을 위해 잠시만 기다려 주세요.',
//                         messageType: 'system',
//                     });
//                 }
//             }
//         }
//         // 방 삭제
//         removeChatRoom(roomId);
//     }
//     // 종료한 유저를 대기열에서 제거
//     if (waitingUsers.has(socketId)) {
//         removeFromWaitingQueue(socketId);
//     }
//     console.log(`[server] Disconnected user ${socketId} removed from queue.`);
// }

function handleDisconnection(socketId) {
    const chatRoom = getChatRoomByUser(socketId);

    if (chatRoom) {
        const { roomId, users } = chatRoom;

        const partner = users.find(user=> user.id !== socketId);

        if (partner && partner.socket.entered && parnter.socket.connected) {
            if (!waitingUsers.has(partner.socket.id)) {
                addToWaitingUsers(partner.socket);
                console.log(`${partner.nickname} 대기열 추가`);
                

                    // 상대방에게 연결 종료 알림
                partner.socket.emit('chat-end', {
                    message: '상대방이 연결을 종료하였습니다. \n 재연결을 위해 잠시만 기다려 주세요.',
                    messageType: 'system',
                });
            }
        }
        removeChatRoom(roomId);
    }
    if (waitingUsers.has(socketId)) {
        removeFromWaitingQueue(socketId);
        console.log(` 대기열에서 제거 : ${socketId.nickname}`);
    }
    console.log(`[server] 연결 종료 처리 완료: ${socketId.nickname}`);
}