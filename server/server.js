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
import { userInfo } from 'os';
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
const BLOCKLIST_KEY = 'blocklist';

app.get('/admin=:id&:password/reports', (req, res) => {
    const { id, password } = req.params;

    if (id !== 'master' || password !== 'nulm1004') {
        return res.status(403).send('잘못된 접근입니다.');
    }

    res.sendFile(path.join(__dirname, '../public', 'adminPage.html'));
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

app.post('/admin/blocklist', (req, res) => {
    const { ip } = req.body; // 요청에서 IP 가져오기

    if (!ip) {
        return res.status(400).send('IP 주소가 제공되지 않았습니다.');
    }

    redisClient.sadd(BLOCKLIST_KEY, ip, (err) => {
        if (err) {
            console.error('[redis] Blocklist 추가 오류:', err);
            return res.status(500).send('서버 오류');
        }
        res.send(`IP ${ip}가 차단 목록에 추가되었습니다.`);
    });
});

app.delete('/admin/blocklist', (req, res) => {
    const { ip } = req.body; // 요청에서 IP 가져오기

    if (!ip) {
        return res.status(400).send('IP 주소가 제공되지 않았습니다.');
    }

    redisClient.srem(BLOCKLIST_KEY, ip, (err) => {
        if (err) {
            console.error('[redis] Blocklist 삭제 오류:', err);
            return res.status(500).send('서버 오류');
        }
        res.send(`IP ${ip}가 차단 목록에서 제거되었습니다.`);
    });
});

app.get('/admin/blocklist', (req, res) => {
    redisClient.smembers(BLOCKLIST_KEY, (err, blocklist) => {
        if (err) {
            console.error('[redis] Blocklist 조회 오류:', err);
            return res.status(500).send('서버 오류');
        }
        res.json(blocklist);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(3000, () => {
    console.log('Server is running on http://localhost:3000');
});

const waitingUsers = new Map(); //대기열 관리
const activeChats = new Map(); //활성채팅
const MAX_REPORT = 20; // 최대 리포트 수 


// 세션 타임아웃 설정
// const SESSION_DURATION = 1 * 60 * 1000; //test time 
const SESSION_DURATION = 8 * 60 * 60 * 1000; //8시간


// IPv4 반환
function normalizeIP(ip) {
    
    // if (!ip) return null;
    if (!ip || typeof ip !== 'string') return null;
    const processedIP = ip.split(',')[0].trim();

    // (IPv6 localhost) 변환
    if (processedIP === "::1") {
        return "127.0.0.1";
    } 
    
    // IPv6에서 IPv4 주소 추출
    if (processedIP.startsWith("::ffff:")) {
        return processedIP.replace("::ffff:", "");
    }
    
    return processedIP;
}

// socket 연결
io.on('connection', async (socket) => {
    socket.entered=false;

    /* enter버튼 클릭시 입장대기열 추가 */
    socket.on('enter-state', async() => {

        if(!socket.entered) {
            socket.entered = true; // 버튼을 눌렀을때만 상태변경 
            
            const rawIP = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            console.log(`[debug] Raw IP received:`, rawIP); // 원본 IP 로그
            const userIP = normalizeIP(rawIP);
            // const userIP = normalizeIP(socket.handshake.address);
            console.log(`[debug] Normalized IP:`, userIP); // 처리된 IP 로그

            isBlocked(userIP, async (blocked) => {
                if (blocked) {
                    console.log(`[server] 차단된 IP ${userIP} 접속 불가`);
                    socket.emit('connection-rejected', {
                        message: '접근이 제한된 유저입니다. 관리자에게 문의해 주세요.'
                    });
                    socket.disconnect(true); 
                    return;
                } 

                // 세션 복원 또는 생성
                const sessionId = socket.handshake.query.sessionId;
                let sessionData = null;

                if (sessionId) {
                    sessionData = await getSession(sessionId); // Redis에서 세션 데이터 가져오기
                    if (sessionData) {
                        console.log(`[redis] 기존 세션 복원: ${sessionId}`);
                        sessionData.disconnectedAt = null; // 연결 복원 처리
                        await saveSession(sessionId, sessionData); // Redis에 갱신
                        socket.emit('session-restored', { message: '기존 세션이 복원되었습니다.', sessionId });
                    } else {
                        console.log(`[redis] 기존 세션 없음. 새 세션 생성 필요.`);
                    }
                }

                // 기존 세션이 없으면 새 세션 생성
                if (!sessionData) {
                    const newSessionId = `${userIP}-${Date.now()}`;
                    sessionData = { userIP, lastActivity: Date.now(), background: false }; // 초기 세션 데이터
                    await saveSession(newSessionId, sessionData);
                    console.log(`[redis] 새로운 세션 생성 및 저장 완료: ${newSessionId}`);
                    socket.emit('session-id', { sessionId: newSessionId });
                }

                handleUserConnection(socket, userIP);
                addToWaitingUsers(socket); //대기열 추가
                
                // 대기 상태 메시지 전송
                socket.emit('wait-state', {
                    message: "상대 유저를 찾는 중입니다. \n 잠시만 기다려 주세요.",
                    messageType: 'system'
                });
                matchUsers();
            });
        } else {
            console.log(`[server] ${userIP} 유저는 이미 입장 상태입니다.`);
        }
    }); //enter-state end


    // 메시지 전송 처리
    socket.on('chat-message', async (msg) => {
        const sessionId = socket.handshake.query.sessionId;
        const sessionData = await getSession(sessionId);
        const chatRoom = getChatRoomByUser(socket.id);

        if (!sessionData || !chatRoom) {
            const errorMessage = !sessionData ? '세션 정보를 가져올 수 없습니다.'
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
            userIP: sessionData.userIP,
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
    socket.on('session-action', async (action) => {
        
        const sessionId = socket.handshake.query.sessionId;
        const sessionData = await getSession(sessionId);
    
        if (!sessionId) return;
        if (!sessionData) {
            console.warn(`[server] 세션 데이터 없음: ${sessionId}`);
            return;
        }

        if (action === 'reset') {
            sessionData.background = false;
            sessionData.lastActivity = Date.now(); // 활동 시간 갱신
            await saveSession(sessionId, sessionData, 10800);
            console.log(`[server] 세션이 활성 상태로 복귀: ${sessionId}`);
        } else if (action === 'background') {
            // 백그라운드 상태로 전환
            sessionData.background = true;
            await saveSession(sessionId, sessionData, 10800); // 3시간 TTL
            console.log(`[server] 세션이 백그라운드 상태로 전환되었습니다: ${sessionId}`);
            socket.emit('session-background', { ttl: 10800 });
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
                }
            }
            handleDisconnection(socket.id);
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
    socket.on('disconnect', async()=>{
        const sessionId = socket.handshake.query.sessionId;

        if (sessionId) {
            const sessionData = await getSession(sessionId);
            if (sessionData) {
                sessionData.disconnectedAt = Date.now(); // 연결 해제 시간 기록
                await saveSession(sessionId, sessionData); 
                console.log(`[redis] 세션 일시 중단: ${sessionId}`);
            } else {
                console.warn(`[redis] 세션이 존재하지 않음. 처리 스킵: ${sessionId}`);
            }
        }
        await handleDisconnection(socket.id);
        console.log(`[redis] 연결종료 처리 완료:${socket.id}`);
    });

    // 연결 종료 (유저 요청)
    socket.on('user-disconnect', async () => {
        const sessionId = socket.handshake.query.sessionId; // Redis 세션 ID 가져오기
        console.log(`[server] ${socket.nickname}[${socket.userIP}] 유저 요청 연결 종료.`);

        if (sessionId) {
            await deleteSession(sessionId);
            console.log(`[redis] 세션 삭제 완료: ${sessionId}`);
        }
        handleDisconnection(socket.id);
        socket.entered = false;
        console.log(`[server] 유저 연결 종료 처리 완료: ${socket.id}`);
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
                addToBlockList(partnerIP);
                console.log(`[server] ${partnerIP}님은 신고 한도 초과로 접근이 제한되었습니다.`)
                partnerSocket.emit('report-redirect', {
                     message: `${partnerIP}님은 신고 한도를 초과하여 접근이 제한됩니다. `
                });
                // 연결종료 //세션삭제
                partnerSocket.disconnect(true); 
            } else {
                if (partnerSocket) {
                    setTimeout(() => {
                        addToWaitingUsers(partnerSocket);
                        console.log(`[server] ${partnerIP}님을 5초후 대기열에 추가합니다.`);
                        matchUsers();
                    }, 5000);
                }
            }
        });
        
        if (reporterSocket) {
            setTimeout( () => {
                addToWaitingUsers(reporterSocket);
                console.log(`[server] ${reporterSocket.userIP}님을 대기열에 즉시 추가합니다.`);
                matchUsers();
            }, 2000);
        }
    
        // 클라이언트에게 알림
        reporterSocket?.emit('chat-end', {
            message: '신고가 접수되어 연결을 종료합니다.',
            messageType: 'system'
        });
    
        partnerSocket?.emit('chat-end', {
            message: '상대방이 연결을 종료했습니다.',
            messageType: 'system'
        });

        // 서버 응답 전송
        // reporterSocket.emit('report-response', { success: true, message: '신고가 처리되었습니다.' });
    })



}); /* io.on connection */


/* function */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 차단 여부 확인 (유저 접근 제한)
function isBlocked(userIP, callback) {
    redisClient.sismember(BLOCKLIST_KEY, userIP, (err, isMember) => {
        if (err) {
            console.error(`[redis] Blocklist 조회 오류: ${err}`);
            callback(false); // 에러 시 차단되지 않은 것으로 간주
            return;
        } 
        console.log(`[debug] BLOCKLIST : ${userIP}, blocked: ${isMember}`);
        callback(isMember === 1);
        // else {
        //     callback(isMember === 1); // Redis `sismember`는 1이면 존재
        // }
    });
}

// 유저 연결 처리 핸들러
async function handleUserConnection(socket, userIP) {
    socket.userIP = userIP;
    socket.nickname = `User_${Math.floor(Math.random() * 1000)}`;
    console.log(`[SERVER] NEW USER CONNECTED! : ${socket.nickname} [IP:${socket.userIP}]`);

    // 닉네임 전송
    socket.emit('set-nickname', socket.nickname);
    
    // Redis 세션 생성 및 저장
    const sessionId = `${userIP}-${Date.now()}`; // 고유 세션 ID 생성
    const sessionData = {
        nickname: socket.nickname,
        userIP,
        lastActivity: Date.now(),
        background: false,
    };

    await saveSession(sessionId, sessionData); // Redis에 세션 저장
    socket.handshake.query.sessionId = sessionId;
    console.log(`[server] 세션 생성 및 저장 완료: ${sessionId}`);
}

/*
 * redis 세션 처리
*/

// redis - 세션 저장
async function saveSession(sessionId, sessionData) {
    const ttl = sessionData.background ? 3 * 60 * 60 : 3 * 60 * 60;  //백그라운드:포그라운드
    sessionData.socketId = sessionData.socketId || null; 
    await redisClient.set(
        `session:${sessionId}`,
        JSON.stringify(sessionData),
        'EX',
        ttl
    );
    console.log(`[redis] sessionId:${sessionId} 저장(TTL: ${ttl}s)`);
}

// redis - 세션 불러오기
async function getSession(sessionId) {
    const session = await redisClient.get(`session:${sessionId}`);
    if (!session) {
        console.log(`[redis] 세션이 삭제되었거나 없습니다: ${sessionId}`);
        return null;
    }
    return JSON.parse(session);
}

// redis - 세션 삭제
async function deleteSession(sessionId) {
    await redisClient.del(`session:${sessionId}`);
    console.log(`[redis] 세션이 삭제되었습니다: ${sessionId}`);
}


async function manageRedisSession(socket, userIP) {
    let sessionId = socket.handshake.query.sessionId;
    let sessionData;

    if (sessionId) {
        sessionData = await getSession(sessionId);
        if (sessionData) {
            console.log(`[server] 세션 복원 성공: ${sessionId}`);
            sessionData.lastActivity = Date.now(); // 마지막 활동 시간 갱신
            await saveSession(sessionId, sessionData); // 세션 갱신
        } else {
            console.log(`[server] 세션이 만료되었습니다. 새로운 세션 생성.`);
            sessionId = null;
        }
    }
    // 새로운 세션 생성
    if (!sessionId || !sessionData) {
        sessionId = `${userIP}-${Date.now()}`;
        sessionData = {
            userIP,
            lastActivity: Date.now(),
            background: false, // 기본값 설정
        };
        await saveSession(sessionId, sessionData);
        console.log(`[server] 새로운 세션 생성: ${sessionId}`);
    }

    // 타임아웃 처리: 일정 시간 후 세션 만료
    setTimeout(async () => {
        await handleSessionTimeout(sessionId);
    }, SESSION_DURATION);

    return sessionId;
}


//세션 만료
async function handleSessionTimeout(sessionId) {
    const sessionData = await getSession(sessionId);

    if (!sessionData) {
        console.warn(`[server] 세션이 이미 만료되었거나 없습니다: ${sessionId}`);
        return;
    }

    const timeSinceActivity = Date.now() - sessionData.lastActivity;
    if (!sessionData.background && timeSinceActivity < SESSION_DURATION) {
        console.log(`[server] 세션이 여전히 활성 상태입니다: ${sessionId}`);
        return;
    }

    await deleteSession(sessionId); // Redis에서 세션 삭제
    console.log(`[server] 세션 만료: ${sessionId}`);

    // 소켓 알림 및 연결 종료
    const socketId = sessionData.socketId; // 세션 데이터에서 socketId 가져오기
    const socket = io.sockets.sockets.get(socketId); // 소켓 객체 가져오기

    if (socket) {
        socket.emit('session-expired', { message: '세션이 만료되었습니다. 다시 접속해 주세요.' });
        socket.disconnect(true); // 소켓 연결 해제
    } else {
        console.warn(`[server] 소켓을 찾을 수 없습니다. socketId: ${socketId}`);
    }
    await handleDisconnection(socketId);
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

// block list 추가
function addToBlockList(userIP) {
    redisClient.sadd(BLOCKLIST_KEY, userIP, (err) => {
        if(err) {
            console.error('[server] blocklist 추가 오류: ', err);
        } else {
            console.log(`[server] blocklist 추가된 유저: ${userIP}`);
        }
    });
}

// 신고 - MAX_REPORT 초과 확인
function checkMaxReports(userIP, callback) {
    redisClient.llen(`reports: ${userIP}`, (err, count)=>{
        if (err) {
                console.error('[redis] 조회 오류:', err);
                callback(false);
                return;
        }
        console.log(`[debug] 신고횟수확인: ${userIP} : ${count}`);
        
        const isExceeded = count >= MAX_REPORT;
        if (isExceeded) {
            addToBlockList(userIP);
        }
        callback(isExceeded);
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
    

        /* 동접자 테스트용 - 매칭 우저에게 알림 전송*/
        user1.socket.emit('matched', {
            message: 'You have been matched!',
            roomId: roomId,
            partner: {
                id: user2.socket.id,
                nickname: user2.socket.nickname,
                userIP: user2.socket.userIP,
            },
        });
        
        console.log(`[server-debug] Matched event data for ${user1.socket.nickname}:`, {
            roomId, partner: user2.socket.nickname,
        });
        

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

    // 디버깅용 로그 추가
    console.log(`[server] Sending chat-ready payload to ${user1.nickname}:`, chatReadyPayload(user1, user2));
    console.log(`[server] Sending chat-ready payload to ${user2.nickname}:`, chatReadyPayload(user2, user1));

    // 방 전체에 경고 메시지 전송
    await delay(1500);
    io.to(roomId).emit('warning-message', {
        message: "금전 또는 개인정보를 요구받을 경우 신고해 주시기 바랍니다. 운영정책을 위반한 메시지로 신고 접수 시 이용에 제한이 있을 수 있습니다.",
        messageType: 'system'
    });
}

// 종료 핸들러
async function handleDisconnection(socketId) {
    const chatRoom = getChatRoomByUser(socketId);

    if (chatRoom) {
        const { roomId, room } = chatRoom;
       
        if (!room || !room.users) {
            console.error(`[server] users 배열을 찾을 수 없습니다.`);
            return;
        }

        const partner = room.users.find(user => user.id !== socketId);

        if (partner && partner.socket && partner.socket.connected) {
            addToWaitingUsers(partner.socket);
            // 상대방에게 연결 종료 알림
            partner.socket.emit('chat-end', {
                message: '상대방이 연결을 종료하였습니다. \n 새로운 유저를 찾습니다.',
                messageType: 'system',
            });
        }
        removeChatRoom(roomId);
    }

    if (waitingUsers.has(socketId)) {
        removeFromWaitingQueue(socketId);
        console.log(`[server] 대기열에서 제거 : ${socketId}`);
    }

    // Redis에서 세션 삭제
    const sessionId = await getSession(socketId); 
    if (sessionId) {
        await deleteSession(sessionId);
        console.log(`[redis] 세션 제거: ${sessionId}`);
    } else {
        console.warn(`[server] 세션 ID를 찾을 수 없습니다. socketId: ${socketId}`);
    }
    console.log(`[server] 연결 종료 처리 완료: ${socketId}`);

}