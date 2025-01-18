// import { io as ioClient } from 'socket.io-client';

// const SERVER_URL = 'http://localhost:3000'; // 서버 URL
// const TOTAL_CLIENTS = 10000; // 동시 접속자 수
// const BATCH_SIZE = 500; // 한 번에 생성할 클라이언트 수
// const DELAY_BETWEEN_BATCHES = 500; // 배치 간 딜레이 (ms)
// const MAX_MATCHES = 5000; // 최대 매칭 건


// let connectedClients = 0; // 현재 연결된 클라이언트 수
// let matchedClients = 0; // 매칭 완료된 클라이언트 수
// const clients = [];
// const connectionTimes = [];
// const matchingTimes = [];

// // 완료 확인
// function checkComplete() {
//     console.log(`[Check Complete] Connected: ${connectedClients}/${TOTAL_CLIENTS}, Matched: ${matchedClients}/${TOTAL_CLIENTS / 2}`);
//     if(matchedClients >= MAX_MATCHES) {
//         summarizeResults();
//         process.exit(0);
//     }
// }

// // 클라이언트 생성 (Promise 반환)
// function createClientAsync(clientIndex) {
//     return new Promise((resolve) => {
//         const startTime = Date.now(); // 연결 시작 시간 기록

//         const socket = ioClient(SERVER_URL, {
//             query: {
//                 sessionId: `session_${clientIndex}`,
//             },
//         });

//         socket.on('connect', () => {
//             connectedClients++;
//             const connectionTime = Date.now() - startTime;
//             connectionTimes.push(connectionTime);
//             console.log(`[Client ${clientIndex}] Connected in ${connectionTime}ms (Total connected: ${connectedClients})`);
//             socket.emit('enter-state');
//             checkComplete();
//             resolve(); // 연결 완료 후 Promise 해제
//         });

//         socket.on('set-nickname', (nickname) => {
//             console.log(`[Client ${clientIndex}] Assigned Nickname: ${nickname}`);
//         });

//         socket.on('matched', (data) => {
//             const partner = data.user1.id === socket.id ? data.user2 : data.user1; // 상대방 정보
//             matchedClients++;
//             const matchingTime = Date.now() - startTime; // 매칭 소요 시간 계산
//             matchingTimes.push(matchingTime);
        
//             console.log(`[Client ${clientIndex}] Matched in ${matchingTime}ms with ${partner.nickname}. Room ID: ${data.roomId}`);
//             checkComplete();
//         });


//         socket.on('disconnect', () => {
//             connectedClients--;
//             console.log(`[Client ${clientIndex}] Disconnected. Total connected: ${connectedClients}`);
//         });

//         clients.push(socket);
//     });
// }

// // 배치 방식 테스트
// async function startTestBatched(batchSize = BATCH_SIZE, delayBetweenBatches = DELAY_BETWEEN_BATCHES) {
//     console.log(`[Test] Starting batched connection test with ${TOTAL_CLIENTS} clients...`);
//     for (let i = 0; i < TOTAL_CLIENTS; i += batchSize) {
//         if (matchedClients >= MAX_MATCHES) {
//             console.log('[Test] Maximum matches reached. Stopping test...');
//             break;
//         }

        
//         const batch = Array.from({ length: Math.min(batchSize, TOTAL_CLIENTS - i) }, (_, index) =>
//             createClientAsync(i + index)
//         );

//         await Promise.all(batch); // 한 배치 완료 후 다음 배치로 진행
//         console.log(`[Test] Batch ${(i / batchSize) + 1} completed.`);
//         if (delayBetweenBatches > 0) await new Promise((res) => setTimeout(res, delayBetweenBatches)); // 딜레이 추가
//     }
//     console.log(`[Test] All clients initiated.`);
// }

// // 테스트 결과 요약 출력
// function summarizeResults() {
//     const filteredTimes = connectionTimes.filter(time => time < 5000); // 5초 이상 제외
//     const avgFilteredTime = (filteredTimes.reduce((a, b) => a + b, 0) / filteredTimes.length / 1000).toFixed(2);
//     // console.log('Filtered Average Connection Time (seconds):', avgFilteredTime);

//     console.log('\n=== Test Summary ===');
//     console.log(`Total clients: ${TOTAL_CLIENTS}`);
//     console.log(`Current clients connected: ${connectedClients}`);
//     console.log(`Total clients matched: ${matchedClients}`);
//     console.log(`Average connection time:`, avgFilteredTime, 'seconds');
//     console.log(`Average matching time: ${(matchingTimes.reduce((a, b) => a + b, 0) / matchingTimes.length / 1000).toFixed(2)} seconds`);
//     console.log('====================\n');
//     process.exit(0); // 프로그램 종료
// }

// // 테스트 시작
// startTestBatched();