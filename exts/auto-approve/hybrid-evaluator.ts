import type { ClassifierApi, ClassifierModel, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ApprovalGuidance } from "../shared/approval-guidance.ts";
import type { EvaluatorConfig } from "./config.ts";
import { evaluateSafety, type EvaluationResult, type EvaluatorContext } from "./evaluator.ts";
import { evaluateSafetyJev } from "./jev-evaluator.ts";

/** Confidence below this boundary routes either classifier choice to chat. */
export const HYBRID_CONFIDENCE_THRESHOLD = 0.25;

export async function evaluateSafetyHybrid(
	classifier: ClassifierModel<ClassifierApi>,
	chat: Model<any>,
	ctx: EvaluatorContext & { modelRegistry: Pick<ModelRegistry, "classify" | "streamSimple"> },
	toolName: string,
	input: Record<string, unknown>,
	config: EvaluatorConfig,
	instructions: readonly string[] = [],
	guidance?: ApprovalGuidance,
): Promise<EvaluationResult> {
	const result = await evaluateSafetyJev(classifier, ctx, toolName, input, config, instructions, guidance);
	const routing: NonNullable<EvaluationResult["routing"]> = {
		classifierModel: { provider: classifier.provider, id: classifier.id },
		chatModel: { provider: chat.provider, id: chat.id },
		classifierChoice: result.classification?.choice ?? null,
		confidence: result.classification?.confidence ?? null,
		fallbackUsed: false,
		classifierAttempt: result.attempt!,
	};
	if (!result.classification || result.cacheable === false || result.classification.confidence >= HYBRID_CONFIDENCE_THRESHOLD) {
		return { ...result, routing };
	}
	const fallback = await evaluateSafety(chat, ctx, toolName, input, config, instructions, guidance);
	return { ...fallback, routing: { ...routing, fallbackUsed: true, chatAttempt: fallback.attempt } };
}
