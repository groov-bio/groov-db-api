import { jest } from '@jest/globals';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDbMock = mockClient(DynamoDBClient);
const docClientMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../../functions/editSensorV2/editSensor.js');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
});

const validData = {
  id: 'GRV-123',
  category: 'TetR',
  type: 'One Component',
  about: 'Test sensor',
  proteins: [
    {
      uniprot_id: 'P12345',
      alias: 'TestProtein',
      family: 'TetR',
    },
    {
      uniprot_id: 'P67890',
      alias: 'AnotherProtein',
      family: 'TetR',
    },
  ],
};

const validBody = {
  category: 'TetR',
  grv_id: 'GRV-123',
  data: validData,
  user: 'testuser',
  timeSubmit: 1640995200000,
};

const baseEvent = (overrides = {}) => ({
  requestContext: { http: { method: 'POST' } },
  headers: { origin: 'https://groov.bio' },
  body: typeof overrides.body === 'string' ? overrides.body : JSON.stringify({ ...validBody, ...overrides }),
  ...overrides,
});

// Prod row matches validData on all read-only fields (type + protein family);
// only the editable `alias` differs, which a valid edit is allowed to change.
const prodRowWithSameProteins = {
  PK: { category: 'TetR', grv_id: 'GRV-123' },
  SK: 'GRV-123',
  data: {
    id: 'GRV-123',
    category: 'TetR',
    type: 'One Component',
    proteins: [
      { uniprot_id: 'P12345', alias: 'ProdVersion1', family: 'TetR' },
      { uniprot_id: 'P67890', alias: 'ProdVersion2', family: 'TetR' },
    ],
  },
};

describe('EditSensorV2', () => {
  beforeEach(() => {
    dynamoDbMock.reset();
    docClientMock.reset();
    process.env.PROD_TABLE_V2_NAME = 'test-prod-v2-table';
    process.env.PROCESSED_TEMP_TABLE_V2_NAME = 'test-processed-v2-table';
  });

  test('OPTIONS preflight returns 200', async () => {
    const res = await handler(baseEvent({ requestContext: { http: { method: 'OPTIONS' } } }));
    expect(res.statusCode).toBe(200);
  });

  test('Invalid JSON body returns 400', async () => {
    const res = await handler(baseEvent({ body: '{not json}' }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toBe('Invalid JSON in request body');
  });

  test('Missing grv_id in body returns 400 validation error', async () => {
    const { grv_id, ...bodyNoGrvId } = validBody;
    const res = await handler(baseEvent({ body: JSON.stringify(bodyNoGrvId) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('Validation Error');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  test('Missing category in body returns 400 validation error', async () => {
    const { category, ...bodyNoCategory } = validBody;
    const res = await handler(baseEvent({ body: JSON.stringify(bodyNoCategory) }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('Validation Error');
  });

  test('Empty proteins array in data returns 400', async () => {
    const res = await handler(baseEvent({
      data: { ...validData, proteins: [] },
    }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('Validation Error');
  });

  test('Missing data.id returns 400', async () => {
    const { id, ...dataNoId } = validData;
    const res = await handler(baseEvent({
      data: dataNoId,
    }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('Validation Error');
  });

  test('Missing data.category returns 400', async () => {
    const { category, ...dataNoCategory } = validData;
    const res = await handler(baseEvent({
      data: dataNoCategory,
    }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('Validation Error');
  });

  test('data.id does not match grv_id returns 400', async () => {
    const res = await handler(baseEvent({
      data: { ...validData, id: 'GRV-WRONG' },
    }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/does not match grv_id/);
  });

  test('data.category does not match category returns 400', async () => {
    const res = await handler(baseEvent({
      data: { ...validData, category: 'LacI' },
    }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/does not match category/);
  });

  test('Prod row missing returns 404', async () => {
    docClientMock.on(GetCommand).resolves({});
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Sensor not found/);
  });

  test('Protein uniprot_ids changed vs prod row returns 400', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            { uniprot_id: 'P12345', alias: 'ProdVersion1' },
            { uniprot_id: 'P99999', alias: 'DifferentProtein' }, // Changed uniprot_id
          ],
        },
      },
    });
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Protein uniprot_ids cannot be changed/);
  });

  test('Client attempt to change sensor type is overwritten with prod value', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: { ...validData, type: 'Two Component' }, // prod is 'One Component'
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putInput.Item.data.type).toBe('One Component'); // forced back to prod
  });

  test('Client attempt to change a read-only protein field (family) is overwritten', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          { uniprot_id: 'P12345', alias: 'TestProtein', family: 'MarR' }, // tampered
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1.family).toBe('TetR'); // forced back to prod, not 'MarR'
  });

  test('Editable fields (alias, regulation_type) pass through unchanged', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          { uniprot_id: 'P12345', alias: 'RenamedProtein', family: 'TetR', regulation_type: 'Activator' },
          { uniprot_id: 'P67890', alias: 'AlsoRenamed', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1.alias).toBe('RenamedProtein');
    expect(p1.regulation_type).toBe('Activator');
  });

  test('Read-only field drift: prod sequence differs but user did not touch it → 202, prod value kept', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            { uniprot_id: 'P12345', alias: 'ProdVersion1', family: 'TetR', sequence: 'PRODSEQ' },
            { uniprot_id: 'P67890', alias: 'ProdVersion2', family: 'TetR' },
          ],
        },
      },
    });
    docClientMock.on(PutCommand).resolves({});
    // Client submits the copy it loaded (a different sequence), unchanged by the user.
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          { uniprot_id: 'P12345', alias: 'TestProtein', family: 'TetR', sequence: 'LOADEDSEQ' },
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1.sequence).toBe('PRODSEQ'); // forced to prod value, no false rejection
  });

  test('References are editable: a corrected DOI/author is saved and interaction is preserved', async () => {
    const prodReferences = [{
      title: 'A paper',
      doi: '10.1/OLD',
      authors: [{ last_name: 'Smith', first_name: 'A' }],
      // Legacy dead data: interaction is an array of rich objects in prod. The
      // edit form leaves it untouched, so a genuine edit must carry it through.
      interaction: [{ figure: 'Figure 1', interaction_type: 'Stimulus', method: 'EMSA' }],
    }];
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            { uniprot_id: 'P12345', alias: 'ProdVersion1', family: 'TetR', references: prodReferences },
            { uniprot_id: 'P67890', alias: 'ProdVersion2', family: 'TetR' },
          ],
        },
      },
    });
    docClientMock.on(PutCommand).resolves({});
    // The edit corrects the DOI and adds a co-author, leaving interaction as-is.
    const editedReferences = [{
      title: 'A paper',
      doi: '10.1/CORRECTED',
      authors: [{ last_name: 'Smith', first_name: 'A' }, { last_name: 'Jones', first_name: 'B' }],
      interaction: [{ figure: 'Figure 1', interaction_type: 'Stimulus', method: 'EMSA' }],
    }];
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          {
            uniprot_id: 'P12345', alias: 'TestProtein', family: 'TetR',
            references: editedReferences,
          },
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    // The corrected references are saved (not forced back to prod), and the
    // deprecated interaction array rides along unchanged.
    expect(p1.references).toEqual(editedReferences);
  });

  test('References with rich (object) interaction are accepted and preserved byte-for-byte', async () => {
    // The edit form now loads/submits interaction untouched as the legacy rich
    // objects (no longer flattened to strings). The schema must accept them and
    // the prod array must round-trip unchanged so a no-op edit diffs cleanly.
    const prodReferences = [{
      title: 'A paper',
      doi: '10.1/x',
      interaction: [{ figure: 'Figure 1', interaction_type: 'Stimulus', method: 'S1 nuclease mapping' }],
    }];
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            { uniprot_id: 'P12345', alias: 'ProdVersion1', family: 'TetR', references: prodReferences },
            { uniprot_id: 'P67890', alias: 'ProdVersion2', family: 'TetR' },
          ],
        },
      },
    });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          {
            uniprot_id: 'P12345', alias: 'TestProtein', family: 'TetR',
            // Submitted with interaction as the untouched rich objects.
            references: [{
              title: 'A paper', doi: '10.1/x',
              interaction: [{ figure: 'Figure 1', interaction_type: 'Stimulus', method: 'S1 nuclease mapping' }],
            }],
          },
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1.references).toEqual(prodReferences);
  });

  test('Origin and mutations are forced back to prod: an edit cannot change them', async () => {
    const prodOrigin = [{ type: 'wild-type', organism_name: 'E. coli', organism_id: 562 }];
    const prodMutations = [{ mutations: ['A1B'], ref_type: 'UniProt', ref_id: 'P12345' }];
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            {
              uniprot_id: 'P12345', alias: 'ProdVersion1', family: 'TetR',
              origin: prodOrigin, mutations: prodMutations,
            },
            { uniprot_id: 'P67890', alias: 'ProdVersion2', family: 'TetR' },
          ],
        },
      },
    });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          {
            uniprot_id: 'P12345', alias: 'TestProtein', family: 'TetR',
            // Attempt to change origin and mutations — both must be reverted.
            origin: [{ type: 'engineered', organism_name: 'Synthetic', organism_id: 999 }],
            mutations: [{ mutations: ['Z9Y'], ref_type: 'UniProt', ref_id: 'P12345' }],
          },
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1.origin).toEqual(prodOrigin);
    expect(p1.mutations).toEqual(prodMutations);
  });

  test('Origin and mutations absent in prod are stripped: an edit cannot introduce them', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});
    const res = await handler(baseEvent({
      data: {
        ...validData,
        proteins: [
          {
            uniprot_id: 'P12345', alias: 'TestProtein', family: 'TetR',
            origin: [{ type: 'wild-type', organism_name: 'E. coli' }],
            mutations: [{ mutations: ['A1B'], ref_type: 'UniProt', ref_id: 'P12345' }],
          },
          { uniprot_id: 'P67890', alias: 'AnotherProtein', family: 'TetR' },
        ],
      },
    }));
    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    const p1 = putInput.Item.data.proteins.find((p) => p.uniprot_id === 'P12345');
    expect(p1).not.toHaveProperty('origin');
    expect(p1).not.toHaveProperty('mutations');
  });

  test('Happy path: valid edit submission returns 202', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});

    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.submissionUUID).toBe('EDIT#GRV-123');
    expect(body.message).toMatch(/Edit submitted for admin review/);

    // Verify the PutCommand was called with correct structure
    const putCalls = docClientMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const putInput = putCalls[0].args[0].input;
    expect(putInput.TableName).toBe('test-processed-v2-table');
    expect(putInput.Item.PK).toBe('PROCESSED');
    expect(putInput.Item.SK).toBe('EDIT#GRV-123');
    expect(putInput.Item.isEdit).toBe(true);
    expect(putInput.Item.editTarget).toEqual({ category: 'TetR', grv_id: 'GRV-123' });
    expect(putInput.Item.proposed_grv_id).toBe(null);
    expect(putInput.Item.user).toBe('testuser');
    expect(putInput.Item.editTimestamp).toBe(1640995200000);
    expect(putInput.Item.data).toEqual(validData);
    // Pre-edit baseline snapshot for the admin diff view.
    expect(putInput.Item.previousData).toEqual(prodRowWithSameProteins.data);
  });

  test('Happy path: preserves data fields exactly (stimulus_type, stimulusType)', async () => {
    const dataWithStimulusType = {
      ...validData,
      stimulus_type: [{ small_molecule: [] }], // snake_case preserved
    };
    const bodyWithStimulus = {
      ...validBody,
      data: dataWithStimulusType,
    };

    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});

    const res = await handler(baseEvent({ ...bodyWithStimulus }));

    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putInput.Item.data.stimulus_type).toEqual([{ small_molecule: [] }]);
  });

  test('Prod row GetCommand uses correct key structure', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});

    await handler(baseEvent());

    const getCalls = docClientMock.commandCalls(GetCommand);
    expect(getCalls).toHaveLength(1);
    const getInput = getCalls[0].args[0].input;
    expect(getInput.TableName).toBe('test-prod-v2-table');
    expect(getInput.Key).toEqual({ category: 'TetR', grv_id: 'GRV-123' });
  });

  test('Multiple proteins with same uniprot_id set matches exactly', async () => {
    const threeProteinData = {
      ...validData,
      proteins: [
        { uniprot_id: 'P11111', alias: 'Protein1' },
        { uniprot_id: 'P22222', alias: 'Protein2' },
        { uniprot_id: 'P33333', alias: 'Protein3' },
      ],
    };

    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: {
          ...prodRowWithSameProteins.data,
          proteins: [
            { uniprot_id: 'P33333', alias: 'ProdProtein3' },
            { uniprot_id: 'P11111', alias: 'ProdProtein1' },
            { uniprot_id: 'P22222', alias: 'ProdProtein2' },
          ], // Order differs but set is same
        },
      },
    });
    docClientMock.on(PutCommand).resolves({});

    const res = await handler(baseEvent({
      data: threeProteinData,
    }));

    expect(res.statusCode).toBe(202);
  });

  test('Prod row with missing proteins field treats as empty array', async () => {
    docClientMock.on(GetCommand).resolves({
      Item: {
        ...prodRowWithSameProteins,
        data: { ...prodRowWithSameProteins.data, proteins: undefined },
      },
    });
    docClientMock.on(PutCommand).resolves({});

    // Edit also has proteins, so uniprot_id sets don't match → should fail
    const res = await handler(baseEvent());

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Protein uniprot_ids cannot be changed/);
  });

  test('DynamoDB GetCommand error returns 500', async () => {
    docClientMock.on(GetCommand).rejects(new Error('DynamoDB error'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Error reading prod table/);
  });

  test('DynamoDB PutCommand error returns 500', async () => {
    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).rejects(new Error('Write failed'));
    const res = await handler(baseEvent());
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toMatch(/Error writing to processed-temp table/);
  });

  test('Body without user/timeSubmit uses null and Date.now() defaults', async () => {
    const bodyNoUserOrTime = {
      category: 'TetR',
      grv_id: 'GRV-123',
      data: validData,
    };

    docClientMock.on(GetCommand).resolves({ Item: prodRowWithSameProteins });
    docClientMock.on(PutCommand).resolves({});

    const res = await handler(baseEvent({ body: JSON.stringify(bodyNoUserOrTime) }));

    expect(res.statusCode).toBe(202);
    const putInput = docClientMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putInput.Item.user).toBe(null);
    expect(typeof putInput.Item.editTimestamp).toBe('number');
    expect(putInput.Item.editTimestamp).toBeGreaterThan(0);
  });
});
