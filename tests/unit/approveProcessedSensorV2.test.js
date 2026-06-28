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

  test('derives category from proteins[].family when top-level category is absent (real addNewSensorV2 shape)', async () => {
    mockMintNextGrvId.mockResolvedValueOnce('GRV-D00004');
    // Mirrors what constructV2Sensor actually writes: no top-level `category`,
    // category lives on each protein as `family`; two proteins => Two Component.
    const data = {
      id: null,
      proposed_grv_id: null,
      type: 'Two Component',
      about: 'test',
      proteins: [
        { alias: 'BqsS', family: 'Other', uniprot_id: 'Q9I0I2', origin: [{ organism_name: 'P. aeruginosa' }], stimulus: [] },
        { alias: 'BqrR', family: 'Other', uniprot_id: 'Q9I0I1', origin: [{ organism_name: 'P. aeruginosa' }], stimulus: [] },
      ],
    };
    docClientMock.on(GetCommand).resolves({ Item: { PK: 'PROCESSED', SK: 'uuid-1', data } });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.grv_id).toBe('GRV-D00004');
    expect(body.category).toBe('Dual');
    expect(mockMintNextGrvId.mock.calls[0][0]).toBe('D');
    const item = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.category).toBe('Dual');
  });

  test('two-component sensor with OmpR/HisKA families approves into the Dual bucket', async () => {
    mockMintNextGrvId.mockResolvedValueOnce('GRV-D00005');
    // OmpR/HisKA are the structural families of the individual proteins in a
    // two-component system and are intentionally absent from CATEGORY_PREFIX.
    // The sensor still collapses into the Dual bucket via type === 'Two Component'.
    const data = {
      id: null,
      proposed_grv_id: null,
      type: 'Two Component',
      about: 'test',
      proteins: [
        { alias: 'EnvZ', family: 'HisKA', uniprot_id: 'P0AEJ4', origin: [{ organism_name: 'E. coli' }], stimulus: [] },
        { alias: 'OmpR', family: 'OmpR', uniprot_id: 'P0AA16', origin: [{ organism_name: 'E. coli' }], stimulus: [] },
      ],
    };
    docClientMock.on(GetCommand).resolves({ Item: { PK: 'PROCESSED', SK: 'uuid-1', data } });
    docClientMock.on(PutCommand).resolves({});
    docClientMock.on(DeleteCommand).resolves({});

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.grv_id).toBe('GRV-D00005');
    expect(body.category).toBe('Dual');
    expect(mockMintNextGrvId.mock.calls[0][0]).toBe('D');
    const item = docClientMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(item.category).toBe('Dual');
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

  describe('Edit branch (isEdit: true)', () => {
    test('approving edit row overwrites prod with same grv_id, no minting, returns 200', async () => {
      const editData = {
        id: 'GRV-T00001',
        category: 'TetR',
        type: 'One Component',
        about: 'updated about',
        proteins: [
          {
            alias: 'UpdatedProtein',
            uniprot_id: 'P00001',
            kegg_id: 'some_updated_kegg',
            origin: [{ organism_name: 'E. coli' }],
            stimulus: [],
          },
        ],
      };

      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-T00001',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-T00001' },
          data: editData,
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).resolves({});

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-T00001' }) }));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Sensor edit approved');
      expect(body.grv_id).toBe('GRV-T00001');
      expect(body.category).toBe('TetR');

      // mintNextGrvId should NOT be called for edit branch
      expect(mockMintNextGrvId).not.toHaveBeenCalled();

      // PutCommand should overwrite prod with ConditionExpression attribute_exists
      const putCalls = docClientMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const putInput = putCalls[0].args[0].input;
      expect(putInput.TableName).toBe('groov_db_table_v2');
      expect(putInput.Item.category).toBe('TetR');
      expect(putInput.Item.grv_id).toBe('GRV-T00001');
      expect(putInput.Item.data).toEqual(editData);
      expect(putInput.ConditionExpression).toBe('attribute_exists(grv_id)');

      // DeleteCommand should remove the processed temp row
      const deleteCalls = docClientMock.commandCalls(DeleteCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input).toMatchObject({
        TableName: 'test-processed-v2',
        Key: { PK: 'PROCESSED', SK: 'EDIT#GRV-T00001' },
      });

      // R2 regen and fingerprint invoke should still happen
      expect(mockRegenerateStaticJSON).toHaveBeenCalledTimes(1);
      expect(mockRegenerateStaticJSON.mock.calls[0]).toEqual([editData, 'TetR', 'GRV-T00001']);
      expect(mockInvokeFingerprintAsync).toHaveBeenCalledTimes(1);
      expect(mockInvokeFingerprintAsync.mock.calls[0][0]).toEqual({
        grv_id: 'GRV-T00001',
        category: 'TetR',
        data: editData,
      });
    });

    test('edit row with data.id set uses that id directly', async () => {
      const editData = {
        id: 'GRV-X00099',
        category: 'LuxR',
        type: 'One Component',
        proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias', family: 'LuxR' }],
      };

      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-X00099',
          isEdit: true,
          editTarget: { category: 'LuxR', grv_id: 'GRV-X00099' },
          data: editData,
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).resolves({});

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-X00099' }) }));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.grv_id).toBe('GRV-X00099');
      expect(body.category).toBe('LuxR');

      const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
      expect(putInput.Item.grv_id).toBe('GRV-X00099');
    });

    test('edit row with missing grv_id in data falls back to editTarget', async () => {
      const editData = {
        // id not set
        category: 'TetR',
        type: 'One Component',
        proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
      };

      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-FALLBACK',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-FALLBACK' },
          data: editData,
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).resolves({});

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-FALLBACK' }) }));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.grv_id).toBe('GRV-FALLBACK');

      const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
      expect(putInput.Item.grv_id).toBe('GRV-FALLBACK');
    });

    test('edit branch returns 404 when prod row does not exist (ConditionalCheckFailedException)', async () => {
      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-NONEXISTENT',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-NONEXISTENT' },
          data: {
            id: 'GRV-NONEXISTENT',
            category: 'TetR',
            proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
          },
        },
      });

      const condErr = new Error('Condition failed');
      condErr.name = 'ConditionalCheckFailedException';
      docClientMock.on(PutCommand).rejects(condErr);

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-NONEXISTENT' }) }));

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/No prod row found/);
    });

    test('edit branch returns 500 when PutCommand throws non-conditional error', async () => {
      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-T00001',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-T00001' },
          data: {
            id: 'GRV-T00001',
            category: 'TetR',
            proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
          },
        },
      });
      docClientMock.on(PutCommand).rejects(new Error('prod write boom'));

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-T00001' }) }));

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.message).toMatch(/Error writing to prod table/);
    });

    test('edit branch returns 200 even when delete-temp throws', async () => {
      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-T00001',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-T00001' },
          data: {
            id: 'GRV-T00001',
            category: 'TetR',
            proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
          },
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).rejects(new Error('delete boom'));

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-T00001' }) }));

      expect(res.statusCode).toBe(200);
      // Should still call PutCommand even though delete fails
      expect(docClientMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test('edit branch returns 200 even when R2 regen throws', async () => {
      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-T00001',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-T00001' },
          data: {
            id: 'GRV-T00001',
            category: 'TetR',
            proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
          },
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).resolves({});
      mockRegenerateStaticJSON.mockRejectedValueOnce(new Error('r2 boom'));

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-T00001' }) }));

      expect(res.statusCode).toBe(200);
      // Prod write should still succeed
      expect(docClientMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test('edit branch returns 200 even when fingerprint invoke throws', async () => {
      docClientMock.on(GetCommand).resolves({
        Item: {
          PK: 'PROCESSED',
          SK: 'EDIT#GRV-T00001',
          isEdit: true,
          editTarget: { category: 'TetR', grv_id: 'GRV-T00001' },
          data: {
            id: 'GRV-T00001',
            category: 'TetR',
            proteins: [{ uniprot_id: 'P12345', alias: 'TestAlias' }],
          },
        },
      });
      docClientMock.on(PutCommand).resolves({});
      docClientMock.on(DeleteCommand).resolves({});
      mockInvokeFingerprintAsync.mockRejectedValueOnce(new Error('lambda boom'));

      const res = await handler(baseEvent({ body: JSON.stringify({ submissionUUID: 'EDIT#GRV-T00001' }) }));

      expect(res.statusCode).toBe(200);
      // Prod write should still succeed
      expect(docClientMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });
});
