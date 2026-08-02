/** PROTOTYPE — intentionally disposable terminal shell for model.ts. */
import * as readline from 'node:readline';
import { ContractStore, RequestEnvelope, ResponseEnvelope } from './model';

const bold = (value: string) => `\x1b[1m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;

const store = new ContractStore();
let lastMutation: RequestEnvelope | undefined;
let lastResponse: ResponseEnvelope | undefined;
let cursor: string | undefined;
let requestNumber = 1;

const request = <TPayload>(
  operationId: string,
  payload: TPayload,
  expectedVersion?: number,
  idempotencyKey = `${operationId}-${requestNumber}`,
): RequestEnvelope<TPayload> => ({
  requestId: `req-${String(requestNumber++).padStart(3, '0')}`,
  operationId,
  idempotencyKey,
  actor: 'developer:demo',
  resource: 'project:demo',
  expectedVersion,
  payload,
});

const showResponse = (response: ResponseEnvelope) => {
  lastResponse = response;
  console.log(JSON.stringify(response, null, 2));
};

const render = () => {
  console.clear();
  const state = store.snapshot();
  console.log(bold('Anyam service-contracts prototype'));
  console.log(dim('Question: one normalized envelope across REST, SDK, MCP, CLI, and webhooks.'));
  console.log();
  console.log(bold('Authoritative project state'));
  console.log(JSON.stringify(state, null, 2));
  console.log();
  console.log(bold('Event stream'));
  console.log(JSON.stringify(store.eventLog(), null, 2));
  console.log();
  console.log(bold('Last response'));
  console.log(JSON.stringify(lastResponse ?? { ok: true, eventIds: [] }, null, 2));
  console.log();
  console.log(bold('Cursor page'));
  try {
    console.log(JSON.stringify(store.listChanges(cursor, 2), null, 2));
  } catch (error) {
    console.log(JSON.stringify(error instanceof Error ? { error: error.message } : error, null, 2));
  }
  console.log();
  console.log(`${bold('[n]')} create Change  ${bold('[r]')} publish revision  ${bold('[l]')} land`);
  console.log(`${bold('[d]')} duplicate last  ${bold('[s]')} stale land  ${bold('[p]')} next page`);
  console.log(`${bold('[x]')} reset cursor  ${bold('[q]')} quit`);
};

const latestChange = () => store.snapshot().changes.at(-1);
const latestRevision = () => store.snapshot().revisions.at(-1);

const runDemo = () => {
  const createRequest = request(
    'change.create',
    { title: 'Add normalized contracts' },
    undefined,
    'demo-create',
  );
  showResponse(store.createChange(createRequest));
  showResponse(store.createChange(createRequest));
  showResponse(
    store.createChange({
      ...createRequest,
      requestId: 'req-conflicting-retry',
      payload: { title: 'Different payload under the same key' },
    }),
  );
  const created = latestChange();
  showResponse(
    store.publishRevision(
      request('change.publish_revision', { changeId: created?.id }, store.snapshot().version, 'demo-revision'),
    ),
  );
  const revision = latestRevision();
  showResponse(
    store.land(
      request(
        'project.land',
        { changeId: created?.id, revisionId: revision?.id },
        store.snapshot().version,
        'demo-land',
      ),
    ),
  );
  showResponse(
    store.land(
      request(
        'project.land',
        { changeId: created?.id, revisionId: revision?.id },
        0,
        'demo-stale',
      ),
    ),
  );
  showResponse(
    store.createChange(request('change.create', { title: 'Second contract change' }, undefined, 'demo-create-2')),
  );
  showResponse(
    store.createChange(request('change.create', { title: 'Third contract change' }, undefined, 'demo-create-3')),
  );
  console.log(JSON.stringify(store.listChanges(undefined, 2), null, 2));
  console.log(JSON.stringify(store.listChanges(store.listChanges(undefined, 2).nextCursor, 2), null, 2));
};

if (process.argv.includes('--demo')) {
  runDemo();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  render();
  rl.input.on('data', (chunk: Buffer) => {
    const key = chunk.toString().trim().toLowerCase();
    const state = store.snapshot();
    if (key === 'q') {
      rl.close();
      return;
    }
    if (key === 'n') {
      const next = request('change.create', { title: `Contract change ${state.nextChangeNumber}` });
      lastMutation = next;
      showResponse(store.createChange(next));
    } else if (key === 'r') {
      const change = latestChange();
      if (change) {
        const next = request('change.publish_revision', { changeId: change.id }, state.version);
        lastMutation = next;
        showResponse(store.publishRevision(next));
      }
    } else if (key === 'l') {
      const change = latestChange();
      const revision = latestRevision();
      if (change && revision) {
        const next = request(
          'project.land',
          { changeId: change.id, revisionId: revision.id },
          state.version,
        );
        lastMutation = next;
        showResponse(store.land(next));
      }
    } else if (key === 'd' && lastMutation) {
      if (lastMutation.operationId === 'change.create') {
        showResponse(store.createChange(lastMutation as RequestEnvelope<{ title: string }>));
      } else if (lastMutation.operationId === 'change.publish_revision') {
        showResponse(store.publishRevision(lastMutation as RequestEnvelope<{ changeId: string }>));
      } else {
        showResponse(store.land(lastMutation as RequestEnvelope<{ changeId: string; revisionId: string }>));
      }
    } else if (key === 's') {
      const change = latestChange();
      const revision = latestRevision();
      if (change && revision) {
        const next = request('project.land', { changeId: change.id, revisionId: revision.id }, 0, `stale-${requestNumber}`);
        lastMutation = next;
        showResponse(store.land(next));
      }
    } else if (key === 'p') {
      const page = store.listChanges(cursor, 1);
      cursor = page.nextCursor;
      lastResponse = { ok: true, requestId: 'page', operationId: 'change.list', result: page, eventIds: [] };
    } else if (key === 'x') {
      cursor = undefined;
    }
    render();
  });
}
