// Live check of the quiz path against a real Ollama model: three lecture notes in the layout
// Lecture Companion writes, the plugin's own prompt, client and parser, and checks on what
// came back (count, answers, on-topic, no near-duplicates, nothing foreign to the notes).
//
//   npm run quiz:live                 # 5 runs, 2 model calls each
//   RUNS=1 MODEL=qwen3.5:9b npm run quiz:live
//   SCENARIOS=multi npm run quiz:live # only the 3-topic scenario (1 call per run)
//
import { mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { OllamaClient } from "../src/core/ollama";
import { attachTopics, buildQuizUserMessage, parseQuiz, quizSystemPrompt, type QuizTopic } from "../src/core/quiz";
import { extractTopics, topicLink } from "../src/core/topics";

const MODEL = process.env.MODEL ?? "qwen3.5:9b";
const URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const RUNS = Number(process.env.RUNS ?? 5);
const NUM_CTX = 16384;
// The bundle lives in .e2e/, so prompts and replies land in .e2e/quiz-live-out/ (git-ignored).
const OUT_DIR = path.join(__dirname, "quiz-live-out");

// ------------------------------------------------------------------ fixture notes

interface Lecture {
	date: string;
	title: string;
	summary: string;
	transcript: string;
	myNotes: string;
	/** Terms a question about this lecture is expected to use (lower case). */
	keywords: string[];
}

const lectures: Lecture[] = [
	{
		date: "2026-09-11",
		title: "Isolation forests",
		keywords: ["isolation", "anomal", "path length", "outlier", "random split", "subsampl", "c(n)", "contamination", "unsuccessful search", "lof", "local outlier", "tree", "forest", "score"],
		summary: `### In one sentence
How isolation forests detect anomalies by how quickly random splits isolate a point, and how their score is normalised.

### Key points
- Anomaly detection is unsupervised: there are no labels, only the assumption that anomalies are few and different. [01:10]
- An isolation tree picks a random feature and a random split value between that feature's min and max, and recurses until every point is alone or the depth limit is reached. [04:32]
- Anomalies are isolated close to the root, so their path length h(x) is short; normal points sit in dense regions and need many splits. [07:45]
- The forest averages h(x) over 100 trees; each tree is grown on a subsample of 256 points, which keeps the trees shallow and the cost linear in the data size. [11:20]
- The score is s(x, n) = 2^(-E[h(x)] / c(n)), where c(n) is the average path length of an unsuccessful search in a binary search tree, c(n) = 2H(n-1) - 2(n-1)/n. [15:02]
- A score close to 1 means anomaly, close to 0.5 means the point is indistinguishable from normal, and well below 0.5 means a clearly normal point. [18:40]
- The contamination parameter is just the expected fraction of anomalies; it only sets the threshold on the score, it does not change the trees. [22:15]
- Compared with Local Outlier Factor, which compares each point's density with its neighbours' and needs pairwise distances, isolation forests scale better and do not need a distance metric. [26:30]

### Terms and definitions
- **Path length h(x)** — the number of edges from the root to the leaf that isolates x.
- **c(n)** — the normalising constant, the average path length of an unsuccessful search in a binary search tree built from n points.
- **Subsampling** — growing each tree on a random 256-point sample of the data rather than the whole set.
- **Contamination** — the assumed fraction of anomalies, used to pick the threshold on the score.

### Worked examples and formulas
- $s(x, n) = 2^{-E[h(x)]/c(n)}$ with $c(n) = 2H(n-1) - 2(n-1)/n$ and $H(i) \\approx \\ln i + 0.5772$.
- Example: with n = 256 and E[h(x)] = 4, c(256) ≈ 10.2, so s ≈ 2^(-0.39) ≈ 0.76: flagged as an anomaly. [20:05]

### Questions to review
- Why are anomalies isolated in fewer splits than normal points?
- What does c(n) normalise, and why is it needed?
- What does a score of exactly 0.5 tell you about a point?`,
		transcript: `**[00:00]** Okay, last week we finished supervised learning, today we start on anomaly detection, which is going to be our first unsupervised method in this course. Think fraud detection on credit card transactions, or sensor failures in a plant.

**[01:10]** The setting is that you have no labels at all. What you do have is an assumption: anomalies are few, and they are different. Few means they are a small fraction of the data, different means their feature values are far from the normal ones in at least some dimensions.

**[04:32]** So here is the idea behind an isolation tree. Pick a feature at random. Pick a split value uniformly at random between the minimum and maximum of that feature in the current node. Everything below goes left, everything above goes right. Recurse. Stop when the node has one point or when you hit the height limit.

**[07:45]** Now why does that detect anomalies? Because a point that is far from everybody else gets cut off very early. A random split in a sparse region is likely to separate it from the rest. A point in a dense cluster needs many splits before it is alone. So path length, the number of edges from the root to the leaf, is short for anomalies and long for normal points.

**[11:20]** We don't trust one tree. We grow a forest, by default one hundred trees, and each tree sees only a subsample of two hundred and fifty six points. That sounds small but it is on purpose, the trees stay shallow and the whole thing runs in time linear in the number of points.

**[15:02]** To turn an average path length into a score we need to know what a typical path length is for n points. That is the same as the average path length of an unsuccessful search in a binary search tree, c of n equals two H of n minus one, minus two times n minus one over n, where H is the harmonic number. The score is two to the minus expected path length over c of n.

**[18:40]** Read the score like this. Close to one, the path was much shorter than typical, anomaly. Around a half, the path was typical, you cannot say anything. Well below a half, longer than typical, that is a very normal point.

**[20:05]** Quick example on the slide, n is two fifty six, c of n is about ten point two, say the average path length for a point is four, then the exponent is minus zero point three nine and the score is about zero point seven six. We would flag it.

**[22:15]** People get confused by the contamination parameter in scikit-learn. It is not part of the algorithm. It is your guess of what fraction of the data is anomalous, and the library uses it to pick a threshold on the score so that that fraction is flagged.

**[26:30]** Compare with Local Outlier Factor, LOF, which we will not cover in depth. LOF compares the density around a point with the density around its neighbours, which needs pairwise distances and a notion of distance that makes sense. Isolation forests need neither, which is why they are the default choice for large tabular data.`,
		myNotes: `- fraud detection example again\n- ask: does the depth limit matter for the score? (prof: yes, points below the limit get the expected remaining length added)`,
	},
	{
		date: "2026-09-18",
		title: "Gradient boosting",
		keywords: ["boost", "residual", "gradient", "learning rate", "shrinkage", "additive", "weak learner", "stump", "xgboost", "early stopping", "bagging", "random forest", "taylor", "leaf", "regulari", "round", "stage"],
		summary: `### In one sentence
Gradient boosting fits an additive model stage by stage, each new tree fitted to the negative gradient of the loss at the current predictions.

### Key points
- Boosting builds F_m(x) = F_{m-1}(x) + ν h_m(x): a sum of weak learners added one at a time, never changing the earlier ones. [02:05]
- Each h_m is fitted to the pseudo-residuals, the negative gradient of the loss with respect to the current prediction; for squared loss that is literally the residual y - F_{m-1}(x). [06:40]
- The learning rate ν (shrinkage) scales each tree's contribution; 0.1 is typical, and a smaller ν needs more trees but generalises better. [12:15]
- Weak learners are shallow trees, depth 3 to 6; depth-1 trees are called stumps. [15:50]
- Stochastic gradient boosting fits each tree on a random subsample of the rows, which adds variance between trees and acts as a regulariser. [19:30]
- Too many rounds overfit; early stopping watches the validation loss and stops when it stops improving. [23:10]
- XGBoost uses a second-order Taylor expansion of the loss and adds regularisation: λ on the leaf weights and γ per leaf, so each extra leaf must earn its gain. [28:45]
- Random forests are bagging: independent deep trees averaged to reduce variance. Boosting adds dependent shallow trees to reduce bias. [34:20]

### Terms and definitions
- **Pseudo-residual** — the negative gradient of the loss at the current prediction, the target the next tree is fitted to.
- **Shrinkage** — the learning rate ν multiplying each new tree.
- **Stump** — a decision tree with a single split.
- **Early stopping** — ending training when the validation loss stops improving for a set number of rounds.

### Worked examples and formulas
- $F_m(x) = F_{m-1}(x) + \\nu\\, h_m(x)$, with $h_m$ fitted to $r_{im} = -\\partial L(y_i, F(x_i)) / \\partial F(x_i)$ at $F = F_{m-1}$.
- Example: targets 3, 5, 10; F_0 is the mean 6; residuals are -3, -1, 4; a stump splitting the third point off predicts -2 and 4; with ν = 0.5 the new predictions are 5, 5, 8. [09:30]
- XGBoost leaf weight: $w_j^* = -\\frac{\\sum g_i}{\\sum h_i + \\lambda}$ for the first and second derivatives g and h in leaf j. [30:10]

### Questions to review
- Why is the residual the right target for squared loss, and what replaces it for other losses?
- What does a smaller learning rate buy you, and what does it cost?
- How do random forests and gradient boosting differ in what they reduce?`,
		transcript: `**[00:00]** Today, gradient boosting. This is the method that wins most tabular data competitions and you should understand why it works, not just how to call it.

**[02:05]** The model is additive. F sub m of x equals F sub m minus one of x plus nu times h sub m of x. We add one weak learner at a time. Earlier learners are frozen, we never go back and refit them.

**[06:40]** How do we choose h sub m? We want to reduce the loss, so we move in the direction of steepest descent, in function space. For each training point compute the negative gradient of the loss with respect to the current prediction. Those numbers are the pseudo-residuals. Fit a small tree to them. For squared loss the negative gradient is just y minus the current prediction, the ordinary residual, which is why people say boosting fits the residuals.

**[09:30]** Tiny example. Targets three, five and ten. F zero is the mean, six. Residuals minus three, minus one, four. Suppose the stump splits the third point off from the other two. Left leaf predicts the mean of minus three and minus one, that is minus two, right leaf predicts four. With nu equal to a half we add half of that, so predictions become five, five and eight.

**[12:15]** Nu is the learning rate, also called shrinkage. Typical value zero point one. Smaller nu means each tree contributes less, so you need more trees, but the model tends to generalise better. It is the single most important knob together with the number of rounds.

**[15:50]** The weak learners are shallow trees, depth three to six is the usual range. A depth one tree, a single split, is called a stump. Deep trees here would overfit quickly because every stage fits noise in the residuals.

**[19:30]** Friedman's stochastic variant fits each tree on a random subsample of the rows, say half of them. That makes the trees less correlated and acts as a regulariser, and it is faster.

**[23:10]** Boosting keeps reducing training loss as long as you add rounds, so it will overfit eventually. The fix is early stopping. Hold out a validation set, watch the validation loss every round, and stop when it has not improved for, say, fifty rounds.

**[28:45]** XGBoost changed two things. First, it uses a second order Taylor expansion of the loss, so it uses both the gradient and the Hessian when it builds a tree. Second, it adds regularisation directly to the objective, lambda times the squared leaf weights and gamma times the number of leaves. So a split is only made if its gain exceeds gamma.

**[30:10]** With that objective the optimal leaf weight has a closed form, minus the sum of the gradients over the sum of the Hessians plus lambda. The lambda in the denominator shrinks the leaf weights toward zero.

**[34:20]** Finally, do not confuse this with random forests. A random forest is bagging, you grow many deep trees independently on bootstrap samples and average them, which reduces variance. Boosting grows shallow trees that depend on each other and mainly reduces bias.`,
		myNotes: `- HW3 uses sklearn GradientBoostingRegressor, try n_estimators vs learning_rate grid\n- early stopping: the n_iter_no_change argument`,
	},
	{
		date: "2026-10-02",
		title: "Backpropagation",
		keywords: ["backprop", "chain rule", "delta", "gradient", "sigmoid", "relu", "vanish", "layer", "weight", "forward pass", "reverse", "autodiff", "mini-batch", "stochastic", "hidden", "activation", "derivative", "error term"],
		summary: `### In one sentence
Backpropagation computes every weight's gradient in one backward sweep by applying the chain rule layer by layer.

### Key points
- A multilayer perceptron computes z^l = W^l a^(l-1) + b^l and a^l = σ(z^l) layer by layer; that is the forward pass. [01:30]
- Training minimises a loss L over the weights with gradient descent, so we need ∂L/∂W^l for every layer. [04:15]
- Define the error term δ^l = ∂L/∂z^l. For the output layer δ^L = ∇_a L ⊙ σ'(z^L). [08:05]
- The recursion δ^l = ((W^(l+1))^T δ^(l+1)) ⊙ σ'(z^l) moves the error one layer back; this is the chain rule applied once per layer. [11:40]
- The weight gradient is ∂L/∂W^l = δ^l (a^(l-1))^T and the bias gradient is δ^l. [14:20]
- One backward sweep costs about twice a forward pass, independent of the number of weights; that is reverse-mode automatic differentiation. [17:00]
- With the sigmoid, σ'(z) is at most 0.25, so δ shrinks by at least a factor of four per layer and the gradients vanish in deep networks; ReLU has derivative 1 for positive inputs and avoids this. [21:10]
- Mini-batch stochastic gradient descent averages the gradient over a small batch, which is noisier than full-batch but much cheaper and usually generalises better. [26:35]

### Terms and definitions
- **Forward pass** — computing the activations of every layer from the input.
- **Error term δ^l** — the gradient of the loss with respect to the pre-activation z^l.
- **Vanishing gradient** — gradients that shrink geometrically with depth, so early layers barely learn.
- **Reverse-mode autodiff** — computing all partial derivatives of one output in a single backward sweep.

### Worked examples and formulas
- $\\delta^L = \\nabla_a L \\odot \\sigma'(z^L)$, $\\delta^l = (W^{l+1})^T \\delta^{l+1} \\odot \\sigma'(z^l)$, $\\partial L / \\partial W^l = \\delta^l (a^{l-1})^T$.
- Example: a 2-layer net with one hidden unit, input 1, target 0, all weights 0.5, sigmoid everywhere, squared loss. Forward: z1 = 0.5, a1 = 0.622, z2 = 0.311, a2 = 0.577. Backward: δ2 = (0.577 - 0)(0.577)(0.423) = 0.141, δ1 = 0.5 · 0.141 · 0.622 · 0.378 = 0.0166. With learning rate 0.1 the output weight becomes 0.5 - 0.1 · 0.141 · 0.622 = 0.491. [23:50]

### Announcements and deadlines
- Homework 4 (backprop by hand and in NumPy) is due October 9.
- The midterm on October 16 covers lectures 1 to 8, including today.

### Questions to review
- Why is δ^l defined with respect to z^l rather than a^l?
- Where exactly does the chain rule enter the recursion for δ^l?
- Why does the sigmoid cause vanishing gradients and why does ReLU not?`,
		transcript: `**[00:00]** Right, last time we set up the multilayer perceptron, today we train it. The algorithm is backpropagation and it is nothing more than the chain rule organised well.

**[01:30]** Recap of the forward pass. Layer l computes z equals W times the previous activation plus b, then a equals sigma of z. Do that from the input to the output. That gives you the prediction.

**[04:15]** We have a loss L, say squared error between the output and the target. Training is gradient descent on the weights, so for every layer we need the partial derivative of L with respect to W of that layer. The naive way, perturb one weight, rerun the network, is one forward pass per weight. Way too slow.

**[08:05]** The trick is to define an intermediate quantity. Delta l is the derivative of the loss with respect to z l, the pre-activation. At the output layer that is the derivative of the loss with respect to the activation, times sigma prime of z, elementwise. That is the Hadamard product, the little circle.

**[11:40]** Now the recursion. Delta at layer l equals W of layer l plus one transposed, times delta of layer l plus one, elementwise times sigma prime of z l. Each step is one application of the chain rule, through the linear map and then through the activation. You run it from the output back to the first hidden layer.

**[14:20]** Once you have the deltas the gradients are trivial. The gradient with respect to W l is delta l times a of l minus one transposed, an outer product. The gradient with respect to the bias is delta l itself.

**[17:00]** Notice what we did. One forward pass, one backward pass, and we have every partial derivative. The backward pass costs roughly twice the forward pass regardless of how many weights there are. This is reverse mode automatic differentiation, and it is why deep learning is possible at all.

**[21:10]** Here is the catch with the sigmoid. Its derivative is sigma times one minus sigma, which peaks at a quarter. So every layer multiplies delta by at most zero point two five. Ten layers deep and the gradient has shrunk by a factor of a million. That is the vanishing gradient problem. ReLU, max of zero and z, has derivative one for positive inputs, so the gradient passes through unchanged, which is the main reason it replaced the sigmoid in hidden layers.

**[23:50]** Worked example on the board, write this down. Two layers, one hidden unit, input one, target zero, every weight a half, sigmoid everywhere, squared loss. Forward, z one is a half, a one is zero point six two two, z two is zero point three one one, a two is zero point five seven seven. Backward, delta two is the error zero point five seven seven times sigma prime, which is zero point five seven seven times zero point four two three, so about zero point one four one. Delta one is the weight a half times delta two times sigma prime at z one, zero point six two two times zero point three seven eight, so about zero point zero one six six. With learning rate zero point one the output weight moves from zero point five to zero point four nine one.

**[26:35]** Last thing. Nobody uses the full training set per step. Mini-batch stochastic gradient descent takes a batch of say thirty two examples, averages their gradients, and steps. Noisier than the full gradient but far cheaper, and the noise actually helps generalisation.

**[29:00]** Homework four is backprop by hand and then in NumPy, due October ninth. The midterm is October sixteenth and covers lectures one through eight, so today is included.`,
		myNotes: `- redo the worked example with ReLU instead of sigmoid\n- midterm Oct 16!!`,
	},
];

/** The exact shape Lecture Companion's renderLectureNote writes (no H1; Slides, Summary, Transcript, My notes). */
function renderLectureNote(course: string, l: Lecture): string {
	return [
		"---",
		`course: "${course}"`,
		`date: ${l.date}`,
		"tags:",
		"  - lecture",
		`title: "${l.title}"`,
		"---",
		"",
		"## Slides",
		"",
		"_No slides yet._",
		"",
		"## Summary",
		"",
		l.summary,
		"",
		"## Transcript",
		"",
		l.transcript,
		"",
		"## My notes",
		"",
		l.myNotes,
		"",
	].join("\n");
}

/** Terms that belong to the course but not to these three lectures; a question using one invents content. */
const FOREIGN_TERMS = ["support vector", "svm", "k-means", "kmeans", "transformer", "attention", "convolution", "cnn", "naive bayes", "principal component", "pca", "reinforcement", "q-learning", "lstm", "recurrent", "logistic regression", "nearest neighbo", "knn", "dropout", "batch norm", "adam", "momentum", "cross-entropy", "softmax", "dbscan", "autoencoder", "gaussian mixture", "kernel"];

// ------------------------------------------------------------------ text helpers

const STOP = new Set(
	"a an the and or but of to in on at for from by with without as is are was were be been being do does did have has had this that these those it its their there here which what when where why how who whom whose if then than so such not no nor can could would should will may might must shall into onto over under about above below between among through during before after while per each every all any some more most much many few less least very also only just even own same other another both either such too via you your yours we our ours they them he she his her i me my mine".split(
		/\s+/,
	),
);
const GENERIC = new Set(
	"explain describe compare contrast derive compute calculate give example examples difference differences student notes lecture using used use uses would could should role purpose mean means meaning define definition briefly step steps result results value values show shows happen happens affect affects matter suppose consider assume according mentioned discussed relate relates following question answer true false whether change changes changing increase increases decrease decreases larger smaller higher lower two three four one first second third last new old same different important main key reason reasons behind terms term intuition intuitively formula formulas equation equations expression expressions quantity quantities number numbers parameter parameters method methods model models algorithm algorithms data point points training train trained test set sets problem problems case cases way ways work works working idea ideas property properties behavior behaviour effect effects approach approaches choice choose chosen setting settings condition conditions assumption assumptions interpretation interpret state states rather instead typically default defaults general generally specific specifically mathematically conceptually practice practical practically process processes stage stages".split(
		/\s+/,
	),
);

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/\$[^$]*\$/g, " ")
		.replace(/[^\p{L}\p{N}']+/gu, " ")
		.split(/\s+/)
		.map((w) => w.replace(/^'+|'+$/g, ""))
		.filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Crude stem so "residuals"/"residual", "isolated"/"isolate" and "trees"/"tree" match. */
function stem(w: string): string {
	return w
		.replace(/(ically|ation|ations|ising|izing|ised|ized|ise|ize)$/, "")
		.replace(/(ness|ment|ments|ingly)$/, "")
		.replace(/(ing|ed|es|s|ly|er|est|al|ity|ies)$/, "")
		.replace(/(ing|ed|s)$/, "");
}

function contentWords(text: string): Set<string> {
	return new Set(tokens(text).filter((w) => !GENERIC.has(w)).map(stem));
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let inter = 0;
	for (const w of a) if (b.has(w)) inter++;
	return inter / (a.size + b.size - inter);
}

// ------------------------------------------------------------------ checks

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}

function checkQuiz(pairs: { question: string; answer: string }[], topics: QuizTopic[], lecturesUsed: Lecture[], count: number, vocab: Set<string>): Check[] {
	const checks: Check[] = [];
	checks.push({ name: `exactly ${count} questions`, ok: pairs.length === count, detail: `got ${pairs.length}` });
	const noAnswer = pairs.filter((p) => !p.answer.trim() || p.answer.trim().length < 15);
	checks.push({ name: "every question has an answer", ok: noAnswer.length === 0, detail: noAnswer.map((p) => p.question).join(" | ") });
	const noLabel = pairs.filter((p) => /^(Q|A|Question|Answer)\s*\d*\s*[:.]/i.test(p.question) || /^(Q|A|Question|Answer)\s*\d*\s*[:.]/i.test(p.answer));
	checks.push({ name: "labels stripped from text", ok: noLabel.length === 0, detail: noLabel.map((p) => p.question).join(" | ") });

	const offTopic = pairs.filter((p) => {
		const q = (p.question + " " + p.answer).toLowerCase();
		return !lecturesUsed.some((l) => l.keywords.some((k) => q.includes(k)) || q.includes(l.title.toLowerCase()));
	});
	checks.push({ name: "every question mentions a topic from the notes", ok: offTopic.length === 0, detail: offTopic.map((p) => p.question).join(" | ") });

	const dupes: string[] = [];
	const sets = pairs.map((p) => contentWords(p.question));
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) {
			const sim = jaccard(sets[i], sets[j]);
			if (sim >= 0.6) dupes.push(`${sim.toFixed(2)}: "${pairs[i].question}" ~ "${pairs[j].question}"`);
		}
	}
	checks.push({ name: "no near-duplicate questions", ok: dupes.length === 0, detail: dupes.join(" | ") });

	const foreign: string[] = [];
	const unknownHeavy: string[] = [];
	for (const p of pairs) {
		const text = (p.question + " " + p.answer).toLowerCase();
		const hits = FOREIGN_TERMS.filter((t) => new RegExp(`(^|[^a-z])${t.replace(/[-]/g, "[- ]?")}`, "i").test(text));
		if (hits.length) foreign.push(`${hits.join(",")} in "${p.question}"`);
		const words = Array.from(contentWords(p.question));
		const unknown = words.filter((w) => !vocab.has(w));
		if (words.length >= 3 && unknown.length / words.length > 0.5) unknownHeavy.push(`${unknown.join(",")} in "${p.question}"`);
	}
	checks.push({ name: "no foreign topics (decoy terms)", ok: foreign.length === 0, detail: foreign.join(" | ") });
	checks.push({ name: "question vocabulary comes from the notes", ok: unknownHeavy.length === 0, detail: unknownHeavy.join(" | ") });

	// Informational: how attachTopics would distribute them.
	const attached = attachTopics(pairs, topics);
	const perTopic = new Map<string, number>();
	for (const a of attached) perTopic.set(a.title, (perTopic.get(a.title) ?? 0) + 1);
	if (topics.length > 1) {
		const covered = topics.filter((t) => (perTopic.get(t.title) ?? 0) > 0).length;
		checks.push({ name: "questions spread over the topics (info)", ok: true, detail: `${covered}/${topics.length} topics mentioned by name; ${Array.from(perTopic.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}` });
	}
	return checks;
}

// ------------------------------------------------------------------ run

function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	const course = "CSCI 470";
	const notes = lectures.map((l) => ({ path: `Courses/${course}/${l.date}.md`, content: renderLectureNote(course, l) }));
	for (const n of notes) writeFileSync(path.join(OUT_DIR, path.basename(n.path)), n.content);

	const extracted = extractTopics(notes);
	console.log(`Topics extracted: ${extracted.map((t) => `"${t.title}" (${t.words} words)`).join(", ")}`);
	if (extracted.length !== lectures.length) fail(`expected ${lectures.length} topics (one per lecture note), got ${extracted.length}`);
	for (const t of extracted) {
		if (!t.text.includes("### Key points")) fail(`topic "${t.title}" text is not the Summary section`);
		if (t.text.includes("**[0")) fail(`topic "${t.title}" text includes the transcript`);
	}
	const vocab = new Set<string>();
	for (const n of notes) for (const w of contentWords(n.content)) vocab.add(w);
	for (const w of contentWords(quizSystemPrompt(5))) vocab.add(w);

	const client = new OllamaClient(() => URL);
	console.log(`Ollama ${await client.version()} at ${URL}, model ${MODEL}, ${RUNS} runs\n`);

	const all: QuizTopic[] = extracted.map((t) => ({ title: t.title, text: t.text, link: topicLink(t) }));
	const scenarios: { name: string; topics: QuizTopic[]; lectures: Lecture[]; count: number }[] = [
		{ name: "3 topics, 5 questions", topics: all, lectures, count: 5 },
		{ name: "1 topic, 3 questions", topics: [all[1]], lectures: [lectures[1]], count: 3 },
	].filter((sc, i) => (process.env.SCENARIOS === "multi" ? i === 0 : true));

	let calls = 0;
	let passedRuns = 0;
	const failures: string[] = [];
	for (let run = 1; run <= RUNS; run++) {
		let runOk = true;
		for (const sc of scenarios) {
			const { message, truncated } = buildQuizUserMessage(sc.topics, sc.count, NUM_CTX);
			if (truncated) fail("fixture text should fit the context window untruncated");
			const t0 = Date.now();
			const reply = await client.chat({
				model: MODEL,
				messages: [
					{ role: "system", content: quizSystemPrompt(sc.count) },
					{ role: "user", content: message },
				],
				options: { num_ctx: NUM_CTX, temperature: 0.6, top_p: 0.9, top_k: 20 },
				keep_alive: "10m",
				think: false,
			});
			calls++;
			const secs = ((Date.now() - t0) / 1000).toFixed(1);
			const file = path.join(OUT_DIR, `run${run}-${sc.name.replace(/[^a-z0-9]+/gi, "-")}.txt`);
			writeFileSync(file, `--- system ---\n${quizSystemPrompt(sc.count)}\n\n--- user ---\n${message}\n\n--- reply ---\n${reply}\n`);
			// What the plugin does: parse, keep the first `count` (models sometimes write one extra).
			const rawCount = parseQuiz(reply).length;
			const pairs = parseQuiz(reply, sc.count);
			const checks = checkQuiz(pairs, sc.topics, sc.lectures, sc.count, vocab);
			const bad = checks.filter((c) => !c.ok);
			console.log(`run ${run} · ${sc.name} · ${secs}s · ${reply.length} chars · ${rawCount} pairs${rawCount !== sc.count ? ` (asked ${sc.count})` : ""} · ${bad.length === 0 ? "PASS" : "FAIL"}`);
			for (const c of checks) if (!c.ok || c.name.endsWith("(info)")) console.log(`    ${c.ok ? "info" : "FAIL"}: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
			if (bad.length) {
				runOk = false;
				failures.push(`run ${run} · ${sc.name}: ${bad.map((c) => c.name).join("; ")} (see ${file})`);
			}
		}
		if (runOk) passedRuns++;
	}
	console.log(`\n${passedRuns}/${RUNS} runs passed, ${calls} model calls.`);
	for (const f of failures) console.log(`  ${f}`);
	process.exit(passedRuns === RUNS ? 0 : 1);
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
