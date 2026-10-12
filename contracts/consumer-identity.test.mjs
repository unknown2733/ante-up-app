import test from 'node:test';
import assert from 'node:assert/strict';
import { consumerLiveNamespace, consumerFreeActionId, parseConsumerFreeActionId } from './consumer-identity.ts';

test('one live action identity survives chart/profile/note roundtrip', () => {
  const namespace = consumerLiveNamespace('devnet', 'Program123');
  const id = consumerFreeActionId(namespace, 'Record456', 'open');
  assert.equal(id, 'devnet:Program123:Record456:open');
  assert.deepEqual(parseConsumerFreeActionId(namespace, id), { recordId: 'Record456', side: 'open' });
  assert.notEqual(id, consumerFreeActionId(namespace, 'Record456', 'close'));
  assert.equal(parseConsumerFreeActionId('devnet:OtherProgram', id), null);
  assert.equal(parseConsumerFreeActionId(namespace, 'free:Record456:open'), null);
  assert.equal(parseConsumerFreeActionId(namespace, 'demo:Record456:open'), null);
  assert.equal(parseConsumerFreeActionId(namespace, id + ':extra'), null);
});

test('identity rejects namespace injection and unapproved network', () => {
  assert.throws(() => consumerLiveNamespace('mainnet', 'Program123'));
  assert.throws(() => consumerFreeActionId('devnet:Program123', 'record:other', 'open'));
  assert.throws(() => consumerFreeActionId('demo:Program123', 'Record456', 'close'));
});
