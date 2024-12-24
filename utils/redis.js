import Redis from 'ioredis';

// Redis 클라이언트 생성
const redisClient = new Redis({
    // host: '211.188.59.208',
    host: '127.0.0.1',
    password: 'nulm1004master',
    port: 6379
});

// 연결 이벤트
redisClient.on('connect', () => {
    console.log('[redis server] connected to redis server');
});

// 에러 이벤트
redisClient.on('error', (err) => {
    console.error('[redis server] redis connection error:', err);
});

// 클라이언트를 외부로 내보내기
export default redisClient;

// // 데이터 저장소 redis 설정 port: 6379
// import Redis from 'ioredis';
// const redis = new Redis();

// //
// const redisClient = redis.createClient ({
//     host: '211.188.59.208',
//     port: 6379,
//     password: 'nulm1004@'
// });

// redisClient.on('connect', () => {
//     console.log('[redis server] connected to redis server')
// });

// // 데이터 저장
// redisClient.set('key', 'value', (err, reply) => {
//     if (err) console.error('Error:', err);
//     else console.log('Set Result:', reply); // OK 출력
// });

// // 데이터 읽기
// redisClient.get('key', (err, reply) => {
//     if (err) console.error('Error:', err);
//     else console.log('Get Result:', reply); // 'value' 출력
// });


// redisClient.on('error', (err) => {
//     console.error('[redis server] redis connection error: ', err);
// });

// // 연결 종료
// redisClient.quit();

// // 클라이언트를 외부로 내보내기
// export default redisClient;