// Answer Checker - marks what students type in the MathLive answer boxes.
//
// MathLive gives us LaTeX (e.g. \frac{7x}{10}). We parse it into a small
// expression tree and compare *values*, so 3/4, 0.75 and \frac{3}{4} all
// count, and algebra is checked by substituting numbers for the letters
// (7x/10 is right, 7/10 and 7y/10 are not). Some questions also check the
// *form*: "simplify fully" wants one fraction with nothing left to cancel.

/* ---------- LaTeX -> expression tree ---------- */
const LatexMath = (() => {
    const COMMANDS = {
        '\\times': '*', '\\cdot': '*', '\\ast': '*', '\\div': '/', '\\pi': 'pi',
        '\\left': null, '\\right': null, '\\,': null, '\\;': null, '\\!': null, '\\ ': null,
    };

    // MathLive writes short arguments without braces: \frac23, \sqrt5. Put the braces back.
    function braceArgs(s) {
        let out = '', i = 0;
        while (i < s.length) {
            const m = /^\\(frac|sqrt)(?![a-zA-Z])/.exec(s.slice(i));
            if (!m) { out += s[i++]; continue; }
            out += m[0]; i += m[0].length;
            if (m[1] === 'sqrt' && s[i] === '[') { const j = s.indexOf(']', i); out += s.slice(i, j + 1); i = j + 1; }
            for (let k = 0; k < (m[1] === 'frac' ? 2 : 1); k++) {
                while (s[i] === ' ') i++;
                if (s[i] === '{') {
                    let depth = 0, j = i;
                    do { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; } while (depth > 0 && j < s.length);
                    out += '{' + braceArgs(s.slice(i + 1, j - 1)) + '}'; i = j;
                } else if (s[i] === '\\') {
                    const c = /^\\[a-zA-Z]+/.exec(s.slice(i))[0];
                    out += '{' + c + '}'; i += c.length;
                } else if (i < s.length) {
                    out += '{' + s[i] + '}'; i++;
                }
            }
        }
        return out;
    }

    function tokenize(src) {
        const s = braceArgs(String(src)
            .replace(/[−–]/g, '-').replace(/×/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3')
            .replace(/\\(?:d|t)frac/g, '\\frac'));
        const toks = [];
        let i = 0;
        while (i < s.length) {
            const c = s[i];
            if (/\s/.test(c)) { i++; continue; }
            if (c === '\\') {
                const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
                const cmd = m[0];
                i += cmd.length;
                if (cmd in COMMANDS) { if (COMMANDS[cmd]) toks.push(COMMANDS[cmd] === 'pi' ? { t: 'pi' } : { t: 'op', v: COMMANDS[cmd] }); continue; }
                if (cmd === '\\frac' || cmd === '\\sqrt') { toks.push({ t: cmd.slice(1) }); continue; }
                if (cmd === '\\placeholder') { toks.push({ t: 'placeholder' }); continue; }
                throw new Error(`I can't mark "${cmd}" here`);
            }
            if (/[0-9.]/.test(c)) {
                const m = /^[0-9]*\.?[0-9]+|^[0-9]+\.?/.exec(s.slice(i));
                toks.push({ t: 'num', v: parseFloat(m[0]) });
                i += m[0].length;
                continue;
            }
            if (/[a-zA-Z]/.test(c)) { toks.push({ t: 'var', v: c }); i++; continue; }
            if ('+-*/^'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
            if ('({['.includes(c)) { toks.push({ t: 'open', v: c }); i++; continue; }
            if (')}]'.includes(c)) { toks.push({ t: 'close', v: c }); i++; continue; }
            throw new Error(`I can't mark the symbol "${c}" here`);
        }
        return toks;
    }

    function parse(src) {
        const toks = tokenize(src);
        let p = 0;
        const peek = () => toks[p];
        const take = () => toks[p++];
        const isOp = v => peek() && peek().t === 'op' && peek().v === v;
        const startsFactor = t => t && (t.t === 'num' || t.t === 'var' || t.t === 'pi' || t.t === 'open' ||
                                         t.t === 'frac' || t.t === 'sqrt');

        function group() {                       // {…}
            const t = take();
            if (!t || t.t !== 'open') throw new Error('something is missing');
            const e = expr();
            const c = take();
            if (!c || c.t !== 'close') throw new Error('a bracket is not closed');
            return e;
        }
        function expr() {
            let left = term();
            while (isOp('+') || isOp('-')) {
                const op = take().v;
                left = { k: op, a: left, b: term() };
            }
            return left;
        }
        function term() {
            let left = unary();
            for (;;) {
                if (isOp('*') || isOp('/')) { const op = take().v; left = { k: op, a: left, b: unary() }; continue; }
                if (startsFactor(peek())) { left = { k: '*', a: left, b: power(), implicit: true }; continue; }   // 7x, 2(x+1)
                return left;
            }
        }
        function unary() {
            if (isOp('-')) { take(); return { k: 'neg', a: unary() }; }
            if (isOp('+')) { take(); return unary(); }
            return power();
        }
        function power() {
            const base = atom();
            if (isOp('^')) {
                take();
                const exp = (peek() && peek().t === 'open' && peek().v === '{') ? group() : unaryAtom();
                return { k: '^', a: base, b: exp };
            }
            return base;
        }
        function unaryAtom() {
            if (isOp('-')) { take(); return { k: 'neg', a: atom() }; }
            return atom();
        }
        function atom() {
            const t = take();
            if (!t) throw new Error('the answer ends too early');
            if (t.t === 'num') return { k: 'num', v: t.v };
            if (t.t === 'var') return { k: 'var', v: t.v };
            if (t.t === 'pi') return { k: 'num', v: Math.PI };
            if (t.t === 'placeholder') throw new Error('there is an empty box in your answer');
            if (t.t === 'open') {
                const e = expr();
                const c = take();
                if (!c || c.t !== 'close') throw new Error('a bracket is not closed');
                return t.v === '{' ? e : { k: 'paren', a: e };
            }
            if (t.t === 'frac') return { k: 'frac', a: group(), b: group() };
            if (t.t === 'sqrt') {
                if (peek() && peek().t === 'open' && peek().v === '[') {
                    take(); const n = expr(); take();
                    return { k: '^', a: group(), b: { k: '/', a: { k: 'num', v: 1 }, b: n } };
                }
                return { k: 'sqrt', a: group() };
            }
            throw new Error('there is a sign in the wrong place');
        }

        if (!toks.length) throw new Error('the answer is empty');
        const tree = expr();
        if (p < toks.length) throw new Error('there is a sign in the wrong place');
        return tree;
    }

    function evaluate(n, vars) {
        switch (n.k) {
            case 'num': return n.v;
            case 'var':
                if (!(n.v in vars)) throw new Error(`unexpected letter ${n.v}`);
                return vars[n.v];
            case 'paren': return evaluate(n.a, vars);
            case 'neg': return -evaluate(n.a, vars);
            case 'sqrt': return Math.sqrt(evaluate(n.a, vars));
            case '+': return evaluate(n.a, vars) + evaluate(n.b, vars);
            case '-': return evaluate(n.a, vars) - evaluate(n.b, vars);
            case '*': return evaluate(n.a, vars) * evaluate(n.b, vars);
            case '/': case 'frac': return evaluate(n.a, vars) / evaluate(n.b, vars);
            case '^': return Math.pow(evaluate(n.a, vars), evaluate(n.b, vars));
        }
        throw new Error('unknown');
    }

    function variables(n, out = new Set()) {
        if (!n) return out;
        if (n.k === 'var') out.add(n.v);
        variables(n.a, out); variables(n.b, out);
        return out;
    }

    // The number in front of each term (1 if none is written), for "can it cancel?"
    // 14x + 6 -> [14, 6];  m^2 -> [1];  20p -> [20]
    function coefficients(n, out = []) {
        if (!n) return out;
        if (n.k === '+' || n.k === '-') { coefficients(n.a, out); coefficients(n.b, out); return out; }
        if (n.k === 'paren' || n.k === 'neg') return coefficients(n.a, out);
        const product = m => m.k === 'num' ? m.v : m.k === '*' ? product(m.a) * product(m.b) : 1;
        out.push(Math.abs(product(n)));
        return out;
    }

    return { parse, evaluate, variables, coefficients };
})();

class AnswerChecker {
    /* Strip "x =", "x_1 =" etc. from the front of an answer */
    static stripLabel(latex) {
        return String(latex || '').replace(/^\s*[a-zA-Z](?:_\{?\d\}?)?\s*=\s*/, '').trim();
    }

    static isEmpty(latex) {
        return !String(latex || '').replace(/\\placeholder\{\}|\s/g, '');
    }

    /* Compare two expressions by value. Letters are tested at several numbers. */
    static sameValue(studentTree, expectedTree, tolerance = 1e-6) {
        const names = new Set([...LatexMath.variables(studentTree), ...LatexMath.variables(expectedTree)]);
        const trials = names.size ? 8 : 1;
        let compared = 0;
        for (let t = 0; t < trials; t++) {
            const vars = {};
            [...names].forEach((name, i) => { vars[name] = 1.37 + 0.91 * t + 0.53 * i; });   // fixed, awkward values
            let a, b;
            try { b = LatexMath.evaluate(expectedTree, vars); a = LatexMath.evaluate(studentTree, vars); }
            catch (e) { return false; }
            if (!Number.isFinite(b)) continue;
            if (!Number.isFinite(a)) return false;
            if (Math.abs(a - b) > tolerance * Math.max(1, Math.abs(b))) return false;
            compared++;
        }
        return compared > 0;
    }

    static gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

    /* "Simplify fully": one fraction, nothing that cancels */
    static formProblem(tree, form) {
        if (!form) return null;
        let t = tree;
        while (t.k === 'neg' || t.k === 'paren') t = t.a;
        const isFrac = t.k === 'frac' || t.k === '/';
        const hasFrac = n => !!n && (n.k === 'frac' || n.k === '/' || hasFrac(n.a) || hasFrac(n.b));
        if (form === 'single_fraction' || form === 'simplified_fraction') {
            if (!isFrac || hasFrac(t.a) || hasFrac(t.b)) return 'Nearly: that has the right value, but write it as one single fraction.';
        }
        if (form === 'simplified_fraction' || form === 'simplified') {
            const parts = isFrac ? [t.a, t.b] : [t];
            const nums = [].concat(...parts.map(p => LatexMath.coefficients(p))).filter(n => n > 0);
            const common = nums.every(Number.isInteger) ? nums.reduce((g, n) => this.gcd(g, n), 0) : 1;
            if (isFrac && common > 1) return `Nearly: that has the right value, but it can be simplified further (everything divides by ${common}).`;
        }
        return null;
    }

    /**
     * @param {string|string[]} studentAnswer LaTeX from the answer box (an array of
     *        boxes for solution_set), or the word "none" for "no real solutions"
     * @returns {{correct: boolean, message: string, nearly?: boolean}}
     */
    static check(studentAnswer, correctAnswer, markingMethod, tolerance = 0.01, form = null) {
        try {
            switch (markingMethod) {
                case 'solution_set': return this.checkSolutionSet(studentAnswer, correctAnswer, tolerance);
                case 'solution_pair': return this.checkSolutionPair(studentAnswer, correctAnswer, tolerance);
                case 'numeric_equal':
                case 'fraction_equivalence':
                case 'equivalent':
                    return this.checkEquivalent(studentAnswer, correctAnswer, form);
                default: return this.checkExact(studentAnswer, correctAnswer);
            }
        } catch (e) {
            return { correct: false, message: `I can't read that answer: ${e.message}. Check it and try again.` };
        }
    }

    static checkEquivalent(studentAnswer, correctAnswer, form) {
        const latex = this.stripLabel(studentAnswer);
        if (this.isEmpty(latex)) return { correct: false, message: 'Type an answer first.' };
        const student = LatexMath.parse(latex);
        const expected = [correctAnswer.exact_latex, ...(correctAnswer.alt || [])];
        for (const answer of expected) {
            let tree;
            try { tree = LatexMath.parse(answer); } catch (e) { continue; }
            if (this.sameValue(student, tree)) {
                const problem = this.formProblem(student, form);
                if (problem) return { correct: false, nearly: true, message: problem };
                return { correct: true, message: 'Correct!' };
            }
        }
        const letters = LatexMath.variables(student).size;
        const expectedLetters = LatexMath.variables(LatexMath.parse(correctAnswer.exact_latex)).size;
        if (letters && !expectedLetters) return { correct: false, message: 'Not quite. The answer is a number: no letters needed.' };
        return { correct: false, message: 'Not quite. Check your working and try again.' };
    }

    static checkSolutionSet(studentAnswer, correctAnswer, tolerance) {
        const roots = correctAnswer.roots || [];
        if (studentAnswer === 'none') {
            return roots.length
                ? { correct: false, message: 'This equation does have real solutions. Try the quadratic formula or factorising.' }
                : { correct: true, message: 'Correct! The discriminant is negative, so there are no real solutions.' };
        }
        const boxes = (Array.isArray(studentAnswer) ? studentAnswer : String(studentAnswer).split(','))
            .map(v => this.stripLabel(v)).filter(v => !this.isEmpty(v));
        if (!boxes.length) return { correct: false, message: 'Type your solutions in the boxes first.' };
        if (!roots.length) return { correct: false, message: 'Not quite. Work out the discriminant b² − 4ac first.' };

        const values = boxes.map(v => {
            const tree = LatexMath.parse(v);
            if (LatexMath.variables(tree).size) throw new Error('each box needs a number, like 3 or \\frac{2}{3}');
            return LatexMath.evaluate(tree, {});
        });
        const close = (a, b) => Math.abs(a - b) <= Math.max(tolerance, 1e-9);
        const distinct = roots.filter((r, i) => roots.findIndex(s => close(r, s)) === i);
        const given = values.filter((v, i) => values.findIndex(w => close(v, w)) === i);
        const allFound = distinct.every(r => given.some(v => close(v, r)));
        const noneWrong = given.every(v => distinct.some(r => close(v, r)));
        if (allFound && noneWrong) return { correct: true, message: 'Correct!' };
        if (noneWrong) return { correct: false, nearly: true, message: 'Nearly: that one is right, but there is another solution.' };
        return { correct: false, message: 'Not quite. Put your answer back into the equation to check it.' };
    }

    static checkSolutionPair(studentAnswer, correctAnswer, tolerance) {
        const matches = String(studentAnswer).match(/-?\d+\.?\d*/g);
        if (!matches || matches.length !== 2) return { correct: false, message: 'Write it like x=2, y=3.' };
        const [x, y] = matches.map(parseFloat);
        const [cx, cy] = correctAnswer.pair;
        const ok = Math.abs(x - cx) < tolerance && Math.abs(y - cy) < tolerance;
        return { correct: ok, message: ok ? 'Correct!' : 'Not quite. Check your working and try again.' };
    }

    static checkExact(studentAnswer, correctAnswer) {
        const norm = s => String(s || '').replace(/\s+/g, '').replace(/\\left|\\right/g, '').toLowerCase();
        const ok = [correctAnswer.exact_latex, ...(correctAnswer.alt || [])].some(a => norm(a) === norm(studentAnswer));
        return { correct: ok, message: ok ? 'Correct!' : 'Not quite. Check your working and try again.' };
    }

    /* The model answer, readable, for when a student has used all their tries */
    static modelAnswer(question) {
        const a = question.answer;
        if (question.marking.method === 'solution_set') {
            if (!a.roots || !a.roots.length) return '\\text{No real solutions}';
            const rs = [...new Set(a.roots)];
            return rs.map((r, i) => `x${rs.length > 1 ? `_{${i + 1}}` : ''} = ${a.roots_latex ? a.roots_latex[i] : r}`).join(',\\quad ');
        }
        return a.exact_latex;
    }
}

if (typeof module !== 'undefined') module.exports = { AnswerChecker, LatexMath };
