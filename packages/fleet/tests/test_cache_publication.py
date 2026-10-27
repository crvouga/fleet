"""An old/wrong-key/partial cache upload cannot authorize an installer release."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('wait_cache', Path(__file__).parents[1] / 'scripts/wait-cache.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CacheProofTests(unittest.TestCase):
    def test_exact_revision_closures_and_key_are_required(self):
        paths = ['/nix/store/' + str(n) for n in range(5)]
        proof = {'version': 1, 'revision': 'a' * 40, 'paths': paths, 'publicKey': 'fixture:public', 'signedPaths': 5}
        gate.validate(proof, 'a' * 40, paths, 'fixture:public')
        for patch in ({'revision': 'b' * 40}, {'paths': paths[:-1]}, {'publicKey': 'wrong:public'},
                      {'signedPaths': 0}, {'signedPaths': True}, {'version': 2}):
            with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, 'FLEET_CACHE_PROOF_INVALID'):
                gate.validate({**proof, **patch}, 'a' * 40, paths, 'fixture:public')
