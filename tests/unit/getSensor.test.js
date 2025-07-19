import { afterEach, jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';

const s3Mock = mockClient(S3Client);

const { handler } = await import('../../functions/getSensor/getSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  console.log.mockRestore();
  console.error.mockRestore();
});

describe('GetSensor Test Suite', () => {
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

            const mockSensorData = {
                alias: 'TestSensor',
                family: 'TestFamily',
                ligands: ['ligand1', 'ligand2']
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);
            expect(result.statusCode).toBe(200);
        });

        test('should use default bucket name when S3_BUCKET_NAME is not set in local mode', async () => {
            process.env.IS_LOCAL = 'true';
            delete process.env.S3_BUCKET_NAME;

            const mockSensorData = { alias: 'TestSensor', family: 'TestFamily' };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
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
                    origin: "https://groov.bio"
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('https://groov.bio');
            expect(result.headers['Access-Control-Allow-Methods']).toBe('GET,OPTIONS');
        });

        test('should handle Origin header (capital O)', async () => {
            const mockSensorData = { alias: 'TestSensor', family: 'TestFamily' };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { Origin: 'https://www.groov.bio' },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('https://www.groov.bio');
        });

        test('should use default origin when no origin header is provided', async () => {
            const mockSensorData = { alias: 'TestSensor', family: 'TestFamily' };
            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
                    this.push(null);
                }
            });
            
            s3Mock.on(GetObjectCommand).resolves({ Body: stream });

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: {},
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);
            expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
        });

        test('should use default origin for disallowed origins', async () => {
            const mockSensorData = {
                alias: 'TestSensor',
                family: 'TestFamily',
                ligands: ['ligand1', 'ligand2']
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
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
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
        });
    });

    describe('Query parameter validation', () => {
        test('should return 422 when sensorID is missing', async () => {
            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                },
                queryStringParameters: {
                    family: 'TestFamily'
                    // sensorID is missing
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(422);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Missing sensorID or family in query string.');
        });

        test('should return 422 when family is missing', async () => {
            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                },
                queryStringParameters: {
                    sensorID: 'test-sensor'
                    // family is missing
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(422);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Missing sensorID or family in query string.');
        });

        test('should return 422 when both parameters are missing', async () => {
            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                },
                queryStringParameters: null
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(422);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Missing sensorID or family in query string.');
        });
    });

    describe('S3 data fetching', () => {
        test('should successfully fetch and return sensor data', async () => {
            const mockSensorData = {
                alias: 'TestSensor',
                family: 'TestFamily',
                ligands: ['ligand1', 'ligand2'],
                description: 'Test sensor description'
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
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
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            expect(JSON.parse(result.body)).toEqual(mockSensorData);
            
            const s3Calls = s3Mock.calls();
            expect(s3Calls.length).toBeGreaterThan(0);
            expect(s3Calls[0].args[0].input.Key).toBe('sensors/testfamily/test-sensor.json');
        });

        test('should handle case-insensitive family names', async () => {
            const mockSensorData = {
                alias: 'TestSensor',
                family: 'TestFamily'
            };

            const stream = new Readable({
                read() {
                    this.push(Buffer.from(JSON.stringify(mockSensorData)));
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
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TESTFAMILY'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(200);
            
            const s3Calls = s3Mock.calls();
            expect(s3Calls[0].args[0].input.Key).toBe('sensors/testfamily/test-sensor.json');
        });
    });

    describe('Error handling', () => {
        test('should return 404 when sensor is not found', async () => {
            const noSuchKeyError = new Error('NoSuchKey');
            noSuchKeyError.name = 'NoSuchKey';
            
            s3Mock.on(GetObjectCommand).rejects(noSuchKeyError);

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                },
                queryStringParameters: {
                    sensorID: 'nonexistent-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(404);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Sensor not found');
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
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Failed to fetch sensor data, please try again.');
        });

        test('should handle generic errors without statusCode and default to 500', async () => {
            const genericError = new Error('Generic error without statusCode');
            delete genericError.statusCode;
            
            s3Mock.on(GetObjectCommand).rejects(genericError);

            const event = {
                requestContext: { http: { method: 'GET' } },
                headers: { origin: 'https://groov.bio' },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Failed to fetch sensor data, please try again.');
        });

        test('should handle malformed JSON from S3', async () => {
            // Create a stream with invalid JSON
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
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Failed to fetch sensor data, please try again.');
        });

        test('should handle unexpected errors', async () => {
            // Force an unexpected error
            s3Mock.on(GetObjectCommand).rejects(new Error('Unexpected error'));

            const event = {
                requestContext: {
                    http: {
                        method: 'GET'
                    }
                },
                headers: {
                    origin: 'https://groov.bio'
                },
                queryStringParameters: {
                    sensorID: 'test-sensor',
                    family: 'TestFamily'
                }
            };

            const result = await handler(event);

            expect(result.statusCode).toBe(503);
            const body = JSON.parse(result.body);
            expect(body.message).toBe('Failed to fetch sensor data, please try again.');
        });
    });
});