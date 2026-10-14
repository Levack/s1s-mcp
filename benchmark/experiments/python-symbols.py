"""Extract Python declarations from supplied source data; never execute repository code."""
import ast
import json
import sys


def extract(filename, text):
    tree = ast.parse(text)
    lines = text.splitlines()
    symbols = []

    def visit(node, parents):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                names = parents + [child.name]
                start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                end = child.end_lineno
                if not isinstance(child, ast.ClassDef):
                    signature = '\n'.join(lines[start - 1:min(child.body[0].lineno, start + 8)])
                    doc = ast.get_docstring(child) or ''
                    symbols.append(dict(id=filename + ':' + '.'.join(names), path=filename,
                                        start=start, end=end, signature=signature + '\n' + doc[:400],
                                        body='\n'.join(lines[start - 1:end])))
                visit(child, names)
            else:
                visit(child, parents)
    visit(tree, [])
    return symbols


if __name__ == '__main__':
    output, errors = [], []
    for item in json.load(sys.stdin):
        try:
            output.extend(extract(item['path'], item['text']))
        except (SyntaxError, ValueError, RecursionError) as error:
            errors.append(dict(path=item['path'], error=type(error).__name__))
    json.dump(dict(symbols=output, errors=errors), sys.stdout)
