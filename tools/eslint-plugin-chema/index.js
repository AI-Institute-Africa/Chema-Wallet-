// Local ESLint rules for Chema Wallet invariants.
// no-number-money: money must be Money / bigint minor units — never `number`.
// Flags a `number` type on any identifier, property, parameter or function
// return whose name contains a money word (amount, fee, net, gross, balance...).
// Names ending in a unit word (count, hours, years, ms...) are not money.

const MONEY_WORDS = new Set([
  'amount', 'amounts', 'minor', 'fee', 'fees', 'net', 'gross', 'balance', 'balances',
  'total', 'totals', 'price', 'sum', 'payout', 'payouts', 'credit', 'debit', 'refund', 'money',
]);
const UNIT_WORDS = new Set([
  'count', 'counts', 'pct', 'percent', 'bps', 'ms', 'seconds', 'secs', 'minutes', 'hours', 'days',
  'years', 'index', 'idx', 'len', 'length', 'size', 'version', 'attempts', 'digits', 'id',
]);

export function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function looksLikeMoney(name) {
  const words = wordsOf(name);
  const last = words[words.length - 1];
  if (last && UNIT_WORDS.has(last)) return false;
  return words.some((w) => MONEY_WORDS.has(w));
}

const WRAPPERS = new Set(['TSUnionType', 'TSArrayType', 'TSTypeOperator', 'TSOptionalType']);

function keyName(key) {
  if (!key) return undefined;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return undefined;
}

function nameFor(annotation) {
  const owner = annotation.parent;
  if (!owner) return undefined;
  switch (owner.type) {
    case 'Identifier':
      return owner.name;
    case 'TSPropertySignature':
    case 'PropertyDefinition':
    case 'TSIndexSignature':
      return keyName(owner.key);
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (owner.returnType !== annotation) return undefined;
      if (owner.id) return owner.id.name;
      if (owner.parent?.type === 'VariableDeclarator') return keyName(owner.parent.id);
      if (owner.parent?.type === 'MethodDefinition' || owner.parent?.type === 'Property') return keyName(owner.parent.key);
      return undefined;
    case 'TSMethodSignature':
      return owner.returnType === annotation ? keyName(owner.key) : undefined;
    default:
      return undefined;
  }
}

const noNumberMoney = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow `number` for money amounts; use Money / bigint minor units.' },
    messages: {
      money: "'{{name}}' looks like a money amount: use Money / bigint minor units, never number.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSNumberKeyword(node) {
        let cur = node.parent;
        while (cur && WRAPPERS.has(cur.type)) cur = cur.parent;
        if (!cur || cur.type !== 'TSTypeAnnotation') return;
        const name = nameFor(cur);
        if (name && looksLikeMoney(name)) {
          context.report({ node, messageId: 'money', data: { name } });
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'eslint-plugin-chema' },
  rules: { 'no-number-money': noNumberMoney },
};

export default plugin;
