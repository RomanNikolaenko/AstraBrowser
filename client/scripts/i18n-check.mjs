// Перевірка перекладу інтерфейсу: npm run i18n:check
//
// Ключ перекладу — сам український текст (src/app/shared/i18n/i18n.ts). Скрипт збирає ключі з шаблонів
// ('Текст' | t) і коду (tr('…'), translate('…')) і перевіряє, що в EN (src/app/shared/i18n/en.ts) є англійський
// переклад кожного з тими самими {0}, {1}…, що в словнику немає зайвого і що ніде не лишилося українського тексту
// поза перекладом. --missing — лише ключі без перекладу, JSON-масивом.
import {
  parseTemplate,
  BindingPipe,
  Interpolation,
  LiteralPrimitive,
  RecursiveAstVisitor,
  TmplAstRecursiveVisitor,
} from '@angular/compiler';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const app = resolve(import.meta.dirname, '../src/app');
const dictionary = join(app, 'shared/i18n/en.ts');
const SKIP = new Set(['bindings.ts', 'en.ts', 'i18n.ts']);
/** Умови й політика конфіденційності: кожною мовою написані окремо (legal-document.ts), а не через словник. */
const SKIP_DIRS = ['legal/texts/'];
const CYRILLIC = /[Ѐ-ӿ]/;
/** Виклики, перший аргумент яких — ключ перекладу. */
const TRANSLATING = /(^|\.)(tr|translate|t)$/;

/** Як normalize() в i18n.ts. */
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const placeholders = (text) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join(' ');

const keys = new Map();
const problems = [];
const where = (file, offset, source) =>
  `${relative(app, file).replaceAll('\\', '/')}:${source.slice(0, offset).split('\n').length}`;
const addKey = (text, place) => {
  const key = normalize(text);
  if (key && !keys.has(key)) {
    keys.set(key, place);
  }
};

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Шаблон: ключі з ('…' | t) і український текст поза перекладом. */
function checkTemplate(template, file, source, start) {
  const place = (offset) => where(file, start + offset, source);
  const { nodes, errors } = parseTemplate(template, file, { preserveWhitespaces: false });
  for (const error of errors ?? []) {
    problems.push(`${place(error.span.start.offset)}: шаблон не розібрано: ${error.msg}`);
  }

  /** Рядки у виразі: усередині | t — ключі, поза ним українських бути не повинно. */
  class Expressions extends RecursiveAstVisitor {
    translated = 0;
    visitPipe(ast, context) {
      if (ast.name !== 't') {
        return super.visitPipe(ast, context);
      }
      this.translated++;
      ast.exp.visit(this, context);
      this.translated--;
      this.visitAll(ast.args, context);
    }
    visitLiteralPrimitive(ast) {
      if (typeof ast.value !== 'string' || !CYRILLIC.test(ast.value)) {
        return;
      }
      if (this.translated) {
        addKey(ast.value, place(ast.sourceSpan.start));
      } else {
        problems.push(`${place(ast.sourceSpan.start)}: без | t: '${ast.value}'`);
      }
    }
    visitInterpolation(ast, context) {
      for (const text of ast.strings) {
        if (CYRILLIC.test(text)) {
          problems.push(`${place(ast.sourceSpan.start)}: текст без | t: «${normalize(text)}»`);
        }
      }
      this.visitAll(ast.expressions, context);
    }
  }
  const visit = (value) => {
    const ast = value?.ast ?? value;
    if (ast && typeof ast.visit === 'function') {
      ast.visit(new Expressions());
    }
  };

  class Nodes extends TmplAstRecursiveVisitor {
    visitText(node) {
      if (CYRILLIC.test(node.value)) {
        problems.push(`${place(node.sourceSpan.start.offset)}: текст без | t: «${normalize(node.value)}»`);
      }
    }
    visitTextAttribute(node) {
      if (CYRILLIC.test(node.value)) {
        problems.push(`${place(node.sourceSpan.start.offset)}: атрибут ${node.name} без | t: «${normalize(node.value)}»`);
      }
    }
    visitBoundText(node) {
      visit(node.value);
    }
    visitBoundAttribute(node) {
      visit(node.value);
    }
    visitBoundEvent(node) {
      visit(node.handler);
    }
    visitLetDeclaration(node) {
      visit(node.value);
    }
  }
  const visitor = new Nodes();
  for (const node of nodes) {
    node.visit(visitor);
  }
}

/** Код: ключі з tr('…') і translate('…'), український текст поза ними — проблема. */
function checkCode(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    // Вбудований шаблон компонента.
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(tree) === 'template' &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer)
    ) {
      checkTemplate(node.initializer.text, file, source, node.initializer.getStart(tree) + 1);
      return;
    }
    if (ts.isCallExpression(node) && /(^|\.)plural$/.test(node.expression.getText(tree))) {
      // Форми множини: українські й англійські — прямо у виклику.
      node.arguments.slice(0, 1).forEach(visit);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!CYRILLIC.test(node.text)) {
        return;
      }
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.arguments[0] === node && TRANSLATING.test(parent.expression.getText(tree))) {
        addKey(node.text, where(file, node.getStart(tree), source));
      } else {
        problems.push(`${where(file, node.getStart(tree), source)}: без tr() чи translate(): ${node.getText(tree)}`);
      }
      return;
    }
    if (
      ts.isTemplateExpression(node) &&
      [node.head, ...node.templateSpans.map((span) => span.literal)].some((part) => CYRILLIC.test(part.text))
    ) {
      problems.push(
        `${where(file, node.getStart(tree), source)}: текст зі вставками без translate(): ${node.getText(tree).slice(0, 100)}`
      );
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}

for (const file of files(app)) {
  const name = file.split(/[\\/]/).at(-1);
  const path = relative(app, file).replaceAll('\\', '/');
  if (name.endsWith('.spec.ts') || SKIP.has(name) || SKIP_DIRS.some((dir) => path.startsWith(dir))) {
    continue;
  }
  const source = readFileSync(file, 'utf8');
  if (name.endsWith('.html')) {
    checkTemplate(source, file, source, 0);
  } else if (name.endsWith('.ts')) {
    checkCode(file, source);
  }
}

// Словник: 'український': 'English'.
const english = new Map();
const tree = ts.createSourceFile(dictionary, readFileSync(dictionary, 'utf8'), ts.ScriptTarget.Latest, true);
const literal = (node) => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null);
tree.forEachChild(function visit(node) {
  if (ts.isPropertyAssignment(node)) {
    // Однослівний ключ Prettier пише без лапок.
    const key = ts.isIdentifier(node.name) ? node.name.text : literal(node.name);
    const value = literal(node.initializer);
    if (key === null || value === null) {
      problems.push(`en.ts:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}: ключ і переклад — прості рядки`);
    } else if (english.has(key)) {
      problems.push(`en.ts: ключ двічі: '${key}'`);
    } else {
      english.set(key, value);
    }
    return;
  }
  ts.forEachChild(node, visit);
});

const missing = [...keys.keys()].filter((key) => !english.has(key));
if (process.argv.includes('--missing')) {
  console.log(JSON.stringify(missing, null, 1));
  process.exit(0);
}
for (const key of missing) {
  problems.push(`${keys.get(key)}: немає перекладу в en.ts: '${key}'`);
}
for (const [key, value] of english) {
  if (!keys.has(key)) {
    problems.push(`en.ts: ключ ніде не використовується: '${key}'`);
  } else if (normalize(key) !== key) {
    problems.push(`en.ts: зайві пробіли в ключі: '${key}'`);
  } else if (placeholders(key) !== placeholders(value)) {
    problems.push(`en.ts: різні вставки в '${key}' і '${value}'`);
  } else if (!value.trim() || CYRILLIC.test(value)) {
    problems.push(`en.ts: немає англійського перекладу: '${key}'`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nПроблем із перекладом: ${problems.length}.`);
  process.exit(1);
}
console.log(`Переклад повний: ${keys.size} текстів.`);
