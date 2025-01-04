import Redis from 'ioredis';

// Redis 클라이언트 생성
const redisClient = new Redis({
    host: '127.0.0.1',
    port: 6379,
    connectTimeout: 10000,
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
