/**
 * Private log-record contract for auto-approve evaluator decisions.
 *
 * One record per evaluator invocation, written for benchmark case curation:
 * the example (tool/input/cwd/context/guidance snapshot) is the data; the
 * evaluator's decision is incidental. Cache hits are never logged, and
 * rendered prompts and standard extension guidance are never recorded — only
 * the inputs that drove the decision. Persisting is best-effort: a record
 * that fails to write is simply lost. `accepted` means the verdict was
 * applied; `discarded` means the attempt was valid but its verdict went
 * unused (e.g. session guidance changed mid-flight). Failed attempts log
 * uniformly; the reason text reveals the failure. Log-file location and
 * opt-in mechanics live in the extension.
 *
 * Also the shared field shapes (verdict, effort, guidance snapshot) for the
 * benchmark contracts in benchmark/auto-approve/contracts.ts.
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

export const EVAL_LOG_SCHEMA_VERSION = 1;

export const verdictSchema = Type.Union([Type.Literal("allow"), Type.Literal("review")]);
export const effortSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);

/** Session-guidance snapshot; the null form records that no guidance applied. */
export const guidanceSchema = Type.Object(
	{
		text: Type.String(),
		revision: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export const guidanceSnapshotSchema = Type.Union([guidanceSchema, Type.Null()]);

export const evalLogRecordSchema = Type.Object(
	{
		schemaVersion: Type.Literal(EVAL_LOG_SCHEMA_VERSION),
		/** Epoch milliseconds when the attempt completed. */
		timestamp: Type.Number({ minimum: 0 }),
		tool: Type.String({ minLength: 1 }),
		input: Type.Record(Type.String(), Type.Unknown()),
		cwd: Type.String({ minLength: 1 }),
		/**
		 * Roots supplemental to installation/preset grants; instructions retain
		 * the full evaluated context. Schema 1 also covers older full-root logs.
		 * Only exact raw-string builtin duplicates are omitted; roots alone do
		 * not capture historical scope or whether builtin:defaults was imported.
		 */
		structuredContext: Type.Object(
			{
				writeRoots: Type.Array(Type.String()),
				readRoots: Type.Array(Type.String()),
				instructions: Type.Array(Type.String()),
			},
			{ additionalProperties: false },
		),
		guidance: guidanceSnapshotSchema,
		/** The model that produced the attempt. */
		model: Type.Object(
			{
				provider: Type.String({ minLength: 1 }),
				model: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
		effort: effortSchema,
		routing: Type.Optional(Type.Object({
			classifierModel: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
			chatModel: Type.Object({ provider: Type.String(), id: Type.String() }, { additionalProperties: false }),
			classifierChoice: Type.Union([verdictSchema, Type.Null()]),
			confidence: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
			fallbackUsed: Type.Boolean(),
		}, { additionalProperties: false })),
		decision: verdictSchema,
		reason: Type.String(),
		status: Type.Union([Type.Literal("accepted"), Type.Literal("discarded")]),
	},
	{ additionalProperties: false },
);

export type EvalLogRecord = Static<typeof evalLogRecordSchema>;

export function isEvalLogRecord(value: unknown): value is EvalLogRecord {
	return Value.Check(evalLogRecordSchema, value);
}
