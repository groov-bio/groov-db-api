import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const mockInvokeFingerprintAsync = jest.fn();
const mockRegenerateStaticJSON = jest.fn();
const mockMintNextGrvId = jest.fn();

jest.unstable_mockModule('../../functions/approveProcessedSensorV2/s3UpdaterV2.js', () => ({
  regenerateStaticJSON: mockRegenerateStaticJSON,
  mintNextGrvId: mockMintNextGrvId,
}));

jest.unstable_mockModule('../../functions/approveProcessedSensorV2/lambdaInvoker.js', () => ({
  invokeFingerprintAsync: mockInvokeFingerprintAsync,
}));

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler, CATEGORY_PREFIX, TWO_COMPONENT_PREFIX, prefixFor } = await import(
  '../../functions/approveProcessedSensorV2/approveProcessedSensor.js'
);

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const sampleData = (overrides = {}) => ({
  id: null,
  proposed_grv_id: null,
  type: 'One Component',
  category: 'TetR',
  about: 'test',
  proteins: [
    {
      alias: 'TestProtein',
      uniprot_id: 'P00001',
      kegg_id: null,
      origin: [{ organism_name: 'E. coli' }],
      stimulus: [],
    },
  ],
  ...overrides,
});

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'POST' } },
  headers: { origin: 'https://groov.bio' },
  body: JSON.stringify({ category: 'TetR', submissionUUID: 'uuid-1' }),
  ...overrides,
});

describe('ApproveProcessedSensorV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    mockInvokeFingerprintAsync.mockReset().mockResolvedValue(undefined);
    mockRegenerateStaticJSON.mockReset().mockResolvedValue(undefined);
    mockMintNextGrvId.mockReset().mockResolvedValue('GRV-T00007');
    process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'test-processed-v2';
    process.env.PROD_TABLE_V2_NAME = 'groov_db_table_v2';
    process.env.FINGERPRINT_LAMBDA_NAME = 'test-fingerprint-v2';
  });

  test('CATEGORY_PREFIX covers all v2 categories', () => {
    ['AraC', 'GntR', 'IclR', 'LacI', 'LuxR', 'LysR', 'MarR', 'Other', 'TetR'].forEach((c) => {
      expect(CATEGORY_PREFIX[c]).toBeDefined();
    });
  });

  test('TWO_COMPONENT_PREFIX is D', () => {
    expect(TWO_COMPONENT_PREFIX).toBe('D');
  });

  test('prefixFor returns D for Two Component, category prefix otherwise', () => {
    expect(prefixFor('TetR', { type: 'Two Component' })).toBe('D');
    expect(prefixFor('LuxR', { type: 'Two Component' })).toBe('D');
    expect(prefixFor('TetR', { type: 'One Component' })).toBe('T');
    expect(prefixFor('LuxR', { type: 'One Component' })).toBe('X');
    expect(prefixFor('Other', { type: 'Riboswitch' })).toBe('Z');
  });

  test('OPTIONS preflight returns 200 with V2 CORS', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers['Access-Control-Allow-Methods']).toBe('POST,OPTIONS');
  });

  test('400 on invalid JSON', async () => {
    const res = await handler(baseEvent({ body: '{not json' }));
    expect(res.statusCode).toBe(400);
  });

  test('400 when submissionUUID missing', async () => {
    const res = await handler(baseEvent({ body: JSON.stringify({}) }));
    expect(res.statusCode).toBe(400);
  });

  test('400 when processed row has an unknown category', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'PROCESSED', SK: 'uuid-1', data: sampleData({ category: 'Bogus' }) },
    });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(400);
  });

  test('400 when processed row is missing a category', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'PROCESSED', SK: 'uuid-1', data: sampleData({ category: undefined }) },
    });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(400);
  });

  test('404 when processed-temp row is missing', async () => {
    docClientMock.on(GetCommand).resolves({});
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(404);
  });

  test('409 when data.id is already set', async () => {
    const data = sampleData();
    data.id = 'GRV-T00001';
    docClientMock.on(GetCommand).resolves({ Item: { PK: 'TetR', SK: 'uuid-1', data } });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(409);
  });

  test('happy path (one component): mints from R2, writes prod with {category,grv_id,data}, deletes temp, regens R2, invokes fingerprint', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ grv_id: 'GRV-T00007', category: 'TetR' });

    expect(mockMintNextGrvId).toHaveBeenCalledTimes(1);
    expect(mockMintNextGrvId.mock.calls[0][0]).toBe('T'); // TetR prefix

    const putCalls = docClientMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const item = putCalls[0].args[0].input.Item;
    expect(putCalls[0].args[0].input.TableName).toBe('groov_db_table_v2');
    expect(item.category).toBe('TetR');
    expect(item.grv_id).toBe('GRV-T00007');
    expect(item.data.id).toBe('GRV-T00007');
    expect(item.data.proposed_grv_id).toBeUndefined();
    expect(putCalls[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(grv_id)');

    const deleteCalls = docClientMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input).toMatchObject({
      TableName: 'test-processed-v2',
      Key: { PK: 'PROCESSED', SK: 'uuid-1' },
    });

    expect(mockRegenerateStaticJSON).toHaveBeenCalledTimes(1);
    expect(mockInvokeFingerprintAsync).toHaveBeenCalledTimes(1);
  });

  test('two-component sensor mints with prefix D and writes category=Dual', async () => {
    mockMintNextGrvId.mockResolvedValueOnce('GRV-D00003');
    docClientMock.on(GetCommand).resolves({
      Item: {
        PK: 'TetR',
        SK: 'uuid-1',
        data: sampleData({
          type: 'Two Component',
          proteins: [sampleData().proteins[0], { ...sampleData().proteins[0], alias: 'P2' }],
        }),
      },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.grv_id).toBe('GRV-D00003');
    expect(body.category).toBe('Dual');
    expect(mockMintNextGrvId.mock.calls[0][0]).toBe('D');

    const item = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.category).toBe('Dual');
    expect(item.data.category).toBe('Dual');

    // R2 regen and fingerprint invoke both receive 'Dual'
    expect(mockRegenerateStaticJSON.mock.calls[0][1]).toBe('Dual');
    expect(mockInvokeFingerprintAsync.mock.calls[0][0].category).toBe('Dual');
  });

  test('single-component preserves original category in prod and data', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});

    const res = await handler(baseEvent());
    expect(JSON.parse(res.body).category).toBe('TetR');
    const item = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.category).toBe('TetR');
    expect(item.data.category).toBe('TetR');
  });

  test('500 when GetCommand throws', async () => {
    docClientMock.on(GetCommand).rejects(new Error('ddb down'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });

  test('500 when mintNextGrvId throws', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    mockMintNextGrvId.mockRejectedValueOnce(new Error('r2 down'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });

  test('500 when prod write fails (non-conditional)', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).rejects(new Error('prod boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
  });

  test('409 when prod ConditionalCheckFailedException', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    const condErr = new Error('exists');
    condErr.name = 'ConditionalCheckFailedException';
    docClientMock.on(PutCommand).rejects(condErr);
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(409);
  });

  test('200 even when delete-temp throws (prod already written)', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).rejects(new Error('temp delete boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
  });

  test('200 even when R2 regen throws', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});
    mockRegenerateStaticJSON.mockRejectedValueOnce(new Error('r2 boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
  });

  test('200 even when fingerprint invoke fails', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: { PK: 'TetR', SK: 'uuid-1', data: sampleData() },
    });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});
    mockInvokeFingerprintAsync.mockRejectedValueOnce(new Error('lambda boom'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(200);
  });
});
