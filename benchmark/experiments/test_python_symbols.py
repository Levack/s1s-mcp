"""Regression checks for localization IDs and source spans."""
import unittest
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('python_symbols', Path(__file__).with_name('python-symbols.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
extract = module.extract


class SymbolsTest(unittest.TestCase):
    def test_decorated_async_method_and_nested_function(self):
        text = '''class Client:
    @staticmethod
    async def run(value):
        """Process a request."""
        def helper():
            return value
        return helper()
'''
        rows = extract('client.py', text)
        self.assertEqual([r['id'] for r in rows], ['client.py:Client.run', 'client.py:Client.run.helper'])
        self.assertEqual((rows[0]['start'], rows[0]['end']), (2, 7))
        self.assertIn('@staticmethod', rows[0]['body'])
        self.assertIn('Process a request.', rows[0]['signature'])
        self.assertEqual(rows[1]['start'], 5)

    def test_repository_code_is_not_executed(self):
        rows = extract('unsafe.py', 'raise RuntimeError("must not execute")\ndef target():\n    return 1\n')
        self.assertEqual(rows[0]['id'], 'unsafe.py:target')

    def test_invalid_source_is_not_silently_parsed(self):
        with self.assertRaises(SyntaxError):
            extract('broken.py', 'def incomplete(')


if __name__ == '__main__':
    unittest.main()
