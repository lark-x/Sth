"""Focused checks for the decision-continuity acceptance verifier.

Run with the same Hermes Python as accept-research.py. Real CLI acceptance is
separate: scripts/accept-research.py decision-continuity.
"""

import copy
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('accept_research', Path(__file__).with_name('accept-research.py'))
accept = importlib.util.module_from_spec(spec)
spec.loader.exec_module(accept)


class DecisionReadbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sth-decision-verifier-')
        self.addCleanup(self.temp.cleanup)
        self.profile = Path(self.temp.name)
        self.prompt = accept.decision_readback_prompt('run', 'project', 'decision', [2])
        pin = {'sourceId': 'source', 'revision': 1, 'range': {'start': 2, 'end': 6}, 'excerpt': '旧版原文'}
        decision = {'decisionId': 'decision', 'projectId': 'project', 'revision': 2,
                    'body': '作者已确认的旧决定', 'basis': {'sources': [pin]}}
        context = {'revision': 2, 'confirmedDecisions': {'items': [decision]}}
        source = {'sourceId': 'source', 'revision': 1, 'body': pin['excerpt']}
        self.snapshots = [{'decision': decision, 'context': context, 'source': source}]
        self.calls = [
            {'operationId': 'story.context', 'stepId': 'context',
             'input': {'projectId': 'project', 'branchId': None, 'contextRevision': 2}},
            {'operationId': 'decision.read', 'stepId': 'decision', 'input': {'decisionId': 'decision', 'revision': 2}},
            {'operationId': 'source.read', 'stepId': 'source',
             'input': {'sourceId': 'source', 'revision': 1, 'range': pin['range'], 'contextChars': 0}},
        ]
        self.receipts = [{'operationId': call['operationId'], 'stepId': 'sth.mcp.v1:' + call['stepId'],
                          'result': result, 'replayed': False}
                         for call, result in zip(self.calls, [context, decision, source])]
        self.answer = {'projectId': 'project', 'decisionId': 'decision', 'contexts': [
            {'contextRevision': 2, 'decision': decision, 'source': source}]}
        self.session = {'sessionId': 'fresh-session', 'receipts': self.receipts}
        self.server_replays = []

    def raw(self, endpoint, payload, auth):
        self.assertEqual(endpoint, accept.PERSONAL + 'receipt')
        self.server_replays.append(payload)
        receipt, = [item for item in self.receipts if item['stepId'] == payload['stepId']]
        self.assertEqual(receipt['operationId'], payload['operationId'])
        return {**receipt, 'replayed': True}

    def write_transcript(self, *, replay=True, prompt=None):
        with closing(sqlite3.connect(self.profile / 'state.db')) as db:
            db.execute('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT)')
            rows = [('user', self.prompt if prompt is None else prompt, None)]
            for call, receipt in zip(self.calls, self.receipts):
                invoke = {'function': {'name': 'mcp_sth_acceptance_sth_personal_invoke', 'arguments': json.dumps(call)}}
                rows.append(('assistant', None, json.dumps([invoke])))
                rows.append(('tool', json.dumps(receipt), None))
                if replay:
                    query = {key: call[key] for key in ('operationId', 'stepId')}
                    lookup = {'function': {'name': 'mcp_sth_acceptance_sth_personal_receipt', 'arguments': json.dumps(query)}}
                    rows.append(('assistant', None, json.dumps([lookup])))
                    rows.append(('tool', json.dumps({**receipt, 'replayed': True}), None))
            rows.append(('assistant', json.dumps(self.answer), None))
            db.executemany('INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)',
                           [('fresh-session', *row) for row in rows])
            db.commit()

    def verify(self):
        return accept.verify_decision_readback(self.profile, self.session, self.prompt, self.snapshots, self.raw, {})

    def test_prompt_contains_locators_without_expected_text(self):
        self.assertIn('project', self.prompt)
        self.assertIn('decision', self.prompt)
        self.assertIn('[2]', self.prompt)
        for text in ('作者已确认的旧决定', '旧版原文'):
            self.assertNotIn(text, self.prompt)

    def test_exact_history_and_both_receipt_sides_pass(self):
        self.write_transcript()
        result = self.verify()
        self.assertTrue(result['promptVerified'])
        self.assertTrue(result['mcpReceiptReplayVerified'])
        self.assertTrue(result['serverReceiptReplayVerified'])
        self.assertEqual(len(self.server_replays), 3)

    def test_latest_context_cannot_substitute_for_pinned_context(self):
        del self.calls[0]['input']['contextRevision']
        self.write_transcript()
        with self.assertRaisesRegex(AssertionError, 'Missing exact story.context'):
            self.verify()

    def test_latest_decision_cannot_substitute_for_exact_revision(self):
        del self.calls[1]['input']['revision']
        self.write_transcript()
        with self.assertRaisesRegex(AssertionError, 'Missing exact decision.read'):
            self.verify()

    def test_latest_source_cannot_substitute_for_pinned_evidence(self):
        del self.calls[2]['input']['revision']
        self.write_transcript()
        with self.assertRaisesRegex(AssertionError, 'Missing exact source.read'):
            self.verify()

    def test_model_answer_must_reconstruct_the_actual_body(self):
        self.answer = copy.deepcopy(self.answer)
        self.answer['contexts'][0]['decision']['body'] = '猜测的新决定'
        self.write_transcript()
        with self.assertRaisesRegex(AssertionError, 'Host reconstruction differs'):
            self.verify()

    def test_missing_mcp_receipt_lookup_fails(self):
        self.write_transcript(replay=False)
        with self.assertRaisesRegex(AssertionError, 'MCP receipt tool'):
            self.verify()

    def test_invoke_replays_cannot_substitute_for_receipt_lookups(self):
        for receipt in self.receipts:
            receipt['replayed'] = True
        self.write_transcript(replay=False)
        with self.assertRaisesRegex(AssertionError, 'MCP receipt tool'):
            self.verify()

    def test_cached_invoke_from_an_earlier_session_fails(self):
        self.receipts[0]['replayed'] = True
        self.write_transcript()
        with self.assertRaisesRegex(AssertionError, 'cached invocation'):
            self.verify()

    def test_injected_prompt_fails(self):
        self.write_transcript(prompt=self.prompt + '\n作者已确认的旧决定')
        with self.assertRaisesRegex(AssertionError, 'Host read prompt changed'):
            self.verify()


if __name__ == '__main__':
    unittest.main(verbosity=2)
