import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

const { handler } = await import('../../functions/downloadAllSensors/downloadAllSensors.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('DownloadAllSensors Test Suite', () => {
    beforeEach(() => {
        s3Mock.reset();
        process.env.R2_BUCKET_NAME = 'test-bucket';
        process.env.R2_ENDPOINT = 'https://test-endpoint.com';
        process.env.R2_ACCESS_KEY_ID = 'test-key';
        process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
        delete process.env.IS_LOCAL;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('Environment configuration', () => {
        test('should use local S3 configuration when IS_LOCAL is set', async () => {
            process.env.IS_LOCAL = 'true';
            process.env.S3_BUCKET_NAME = 'local-test-bucket';

            const mockAllSensorsData = {
                sensors: [
                    { id: 'sensor1', family: 'Family1', alias: 'Test Sensor 1' }
                ],
                totalCount: 1
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' }
            };

            const result = await handler(event);
            expect(result.statusCode).toBe(200);
        });

        test('should use default bucket name when S3_BUCKET_NAME is not set in local mode', async () => {
            process.env.IS_LOCAL = 'true';
            delete process.env.S3_BUCKET_NAME;

            const mockAllSensorsData = { sensors: [], totalCount: 0 };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' }
            };

            const result = await handler(event);
            expect(result.statusCode).toBe(200);
        });
    });

    describe('CORS handling', () => {
        test('should handle OPTIONS request', async () => {
            const event = {
                requestContext: {
                    http: {
                        method: 'OPTIONS'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
            expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
        });

        test('should handle Origin header (capital O)', async () => {
            const mockAllSensorsData = { sensors: [], totalCount: 0 };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { Origin: 'https://www.groov.bio' }
            };

            const result = await handler(event);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
        });

        test('should use default origin when no origin header is provided', async () => {
            const mockAllSensorsData = { sensors: [], totalCount: 0 };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: {}
            };

            const result = await handler(event);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
        });

        test('should use default origin for disallowed origins', async () => {
            const mockAllSensorsData = {
                sensors: [
                    { id: 'sensor1', family: 'Family1', alias: 'Test Sensor 1' }
                ],
                totalCount: 1
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://malicious-site.com'
                }
            };

            const result = await handler(event);

            expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
        });
    });

    describe('S3 data fetching', () => {
        test('should successfully fetch and return all sensors data', async () => {
            const mockAllSensorsData = {
                sensors: [
                    { 
                        id: 'sensor1', 
                        family: 'Family1', 
                        alias: 'Test Sensor 1',
                        ligands: ['ligand1', 'ligand2']
                    },
                    { 
                        id: 'sensor2', 
                        family: 'Family2', 
                        alias: 'Test Sensor 2',
                        ligands: ['ligand3']
                    }
                ],
                totalCount: 2,
                lastUpdated: '2024-01-01T00:00:00Z'
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(JSON.parse(result.body)).toEqual(mockAllSensorsData);
            
            const s3Calls = s3Mock.calls();
            expect(s3Calls.length).toBe(1);
            expect(s3Calls[0].args[0].input.Key).toBe('all-sensors.json');
        });

        test('should handle S3 connection errors gracefully', async () => {
            s3Mock.on(GetObjectCommand).rejects(new Error('S3 connection failed'));

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toContain('Failed to fetch all-sensors.json from S3');
        });

        test('should handle generic errors without statusCode and default to 500', async () => {
            const genericError = new Error('Generic error without statusCode');
            delete genericError.statusCode;
            
            s3Mock.on(GetObjectCommand).rejects(genericError);

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toContain('Failed to fetch all-sensors.json from S3');
        });
    });

    describe('Error handling', () => {
        test('should handle malformed JSON from S3', async () => {
            const stream = new Readable({
                read() {
                    this.push(Buffer.from('invalid json'));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toContain('Failed to fetch all-sensors.json from S3');
        });

        test('should handle stream errors', async () => {
            const errorStream = new Readable({
                read() {
                    this.emit('error', new Error('Stream error'));
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: errorStream });

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toContain('Failed to fetch all-sensors.json from S3');
        });
    });

    describe('Edge cases', () => {
        test('should handle different request methods', async () => {
            const mockAllSensorsData = {
                sensors: [],
                totalCount: 0
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockAllSensorsData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: {
                    http: {
                        method: 'POST'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(JSON.parse(result.body)).toEqual(mockAllSensorsData);
        });

        test('should handle empty sensor data', async () => {
            const emptySensorData = {
                sensors: [],
                totalCount: 0,
                lastUpdated: '2024-01-01T00:00:00Z'
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(emptySensorData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(JSON.parse(result.body)).toEqual(emptySensorData);
        });
    });
});
