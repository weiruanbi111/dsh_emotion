import { emotionAnimation, type EmotionEventKind, type EmotionSnapshot } from './emotion';
import type { ExpressionStrategy } from './emotion-diagnostics';

export interface ExpressionInput {
  snapshot: EmotionSnapshot;
  mode: 'chat' | 'whisper';
  userText?: string;
  workState?: string | null;
  /** Historical metadata alone cannot establish a current failure or successful outcome. */
  lastEvent?: EmotionEventKind | null;
  enabled: boolean;
  conf: Record<string, unknown>;
}

export interface ExpressionPlan {
  strategy: ExpressionStrategy;
  animation: string | null;
  /** Fixed instructions only; never copies user text, configuration prompts or model output. */
  context: string;
}

const TECHNICAL_TERMS =
  /代码|脚本|程序|函数|接口|报错|异常|编译|构建|部署|数据库|算法|数据结构|正则|泛型|依赖|单元测试|\b(?:api|sql|http|typescript|javascript|python|node(?:\.js)?|npm|pnpm|git|react|css|html|json|docker|promise|async|await|typeerror|referenceerror|syntaxerror)\b/iu;
const REQUEST_CUES =
  /[?？]|怎么|如何|为什么|解释|修复|排查|检查|实现|调试|分析|帮我|帮忙|请|写一个|写一段|修改|继续|\b(?:explain|debug|fix|write|implement|help|check|why|how)\b/iu;
const ERROR_CUES =
  /报错|出错|失败|异常|\b(?:error|failed|failure|exception|traceback|typeerror|referenceerror|syntaxerror)\b/iu;
const PRESENT_PROBLEM = /现在|这次|刚刚?|又|仍|还|我的|我这|\b(?:my|now|still)\b/iu;
const DIRECT_GREETING =
  /^(?:你好[呀啊]?|嗨|哈[喽啰]|早上好|早安|中午好|下午好|晚上好|晚安|hello|hi|hey|good\s+(?:morning|afternoon|evening))[\s,.!?，。！～~？]*$/iu;

function currentText(value: string | undefined): string {
  // Classify only the current message, without retaining it or walking chat history.
  return typeof value === 'string' ? value.trim().slice(0, 8_000) : '';
}

function proseOf(text: string): string {
  // A quotation mentioning a technical failure is not itself a request for debugging.
  return text.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu, '');
}

function isTechnical(text: string, prose: string): boolean {
  if (/```|(?:^|\n)\s*(?:Traceback\b|(?:TypeError|ReferenceError|SyntaxError)\s*:)/u.test(text)) return true;
  return TECHNICAL_TERMS.test(prose) && REQUEST_CUES.test(prose);
}

function isCurrentErrorHelp(prose: string): boolean {
  if (/如果|假如|假设|要是|倘若|\b(?:if|suppose|assuming)\b/iu.test(prose)) return false;
  if (/是什么意思|含义|\b(?:what\s+(?:is|does)|meaning)\b/iu.test(prose) && !/我的|我这|\bmy\b/iu.test(prose))
    return false;
  if (
    /报错了|出错了|失败了|(?:刚刚?|这次|又|仍然?|还是).{0,16}(?:失败|报错|出错)|失败.{0,12}(?:重试|再试)/u.test(prose)
  )
    return true;
  if (!TECHNICAL_TERMS.test(prose) || !ERROR_CUES.test(prose)) return false;
  // Explaining what an error term means does not establish that the user encountered it.
  if (/是什么意思|是什么|含义|\b(?:what\s+(?:is|does)|meaning)\b/iu.test(prose) && !PRESENT_PROBLEM.test(prose))
    return false;
  return PRESENT_PROBLEM.test(prose) || /修复|排查|调试|帮我|帮忙|\b(?:fix|debug|help)\b/iu.test(prose);
}

/** Expression routing only: no emotion mutations, persistence, generation or user-state inference. */
export function expressionPlan(input: ExpressionInput): ExpressionPlan {
  const text = currentText(input.userText);
  const prose = proseOf(text);
  const technical = input.mode === 'chat' && isTechnical(text, prose);
  const greeting = input.mode === 'chat' && DIRECT_GREETING.test(text);
  const userError = input.mode === 'chat' && isCurrentErrorHelp(prose);
  // A terminal error can linger in a host snapshot. A fresh greeting starts its own context.
  const hostError = input.workState === 'error' && !greeting;
  const currentError = hostError || userError;
  const strategy: ExpressionStrategy = !input.enabled
    ? 'disabled'
    : currentError
      ? 'supportive-chat'
      : technical
        ? 'technical'
        : input.mode === 'whisper'
          ? 'quiet-companion'
          : input.snapshot.label === 'cheerful'
            ? 'warm-chat'
            : input.snapshot.label === 'subdued'
              ? 'supportive-chat'
              : 'neutral-chat';
  const neutral = strategy === 'technical' || currentError || strategy === 'quiet-companion';
  const animation = input.enabled
    ? emotionAnimation(neutral ? { ...input.snapshot, label: 'calm' } : input.snapshot, input.conf)
    : null;
  const rules = [
    '[当前情境与表达规则] 固定人设描述身份与习惯；当前心情只影响用词和节奏；当前明确请求与可观测事实决定回答内容。保留人设，不把桌宠心情当作用户状态或事实。',
    input.mode === 'chat'
      ? '当前是用户主动发起的聊天。准确、完整地回应当前问题优先。原人设中的“短短一句”“20字以内”等限制仅适用于日常碎碎念，不限制技术解答或用户明确要求的内容；需要时分步骤、列出条件并提供代码。'
      : '当前是日常碎碎念，保留原人设的简短自然风格。安静陪伴是合法选择，不要求每次情绪变化都主动说话，不强行开启新话题，不索取回复。',
    '只依据本次实际提供的代码、报错和上下文作判断。没有收到代码或具体报错内容时，说明缺少的信息，不得声称已经看过、理解或修复它们；未验证的推断应明确标记。',
    '宿主回合完成只表示一次执行结束，不等于产出正确、任务成功或用户认可；没有证据时不编造进展或庆祝任务成功。',
    '不根据用户离开、未回复或沉默推断心情，不责怪或惩罚用户，不用内疚、孤独或亏欠话术要求互动。',
  ];
  if (technical)
    rules.push(
      '当前消息具有明确技术请求特征。这是表达路由，不是对任务结果或用户情绪的判断；先解决问题，温和口吻不能删减必要解释、步骤、结论或代码。',
    );
  if (hostError)
    rules.push(
      '当前宿主上报了执行错误。平和地回应当前问题，避免轻快庆祝；不能据此断言失败原因、用户受挫或任务最终失败。',
    );
  if (userError)
    rules.push(
      '用户当前明确提及技术错误。围绕实际给出的证据帮助排查，保持平和，不猜测未提供的代码、错误细节或修复结果。',
    );
  if (greeting) rules.push('按这次普通问候自然回应，不主动把历史工作结果套进这次交流。');
  if (!input.enabled) rules.push('连续情绪已关闭，保留原有语气与动画行为；上面的回答完整性和事实边界规则仍适用。');
  else if (strategy === 'warm-chat')
    rules.push('本次表达可稍带轻快和原人设的俏皮，保持克制，不把开心当作任务成功的证据。');
  else if (strategy === 'supportive-chat')
    rules.push('本次表达平和、克制、支持，不催促、不卖惨，不把桌宠低落说成用户做错了什么。');
  else if (strategy === 'neutral-chat') rules.push('本次表达自然温和，按当前问题需要组织内容。');
  return { strategy, animation, context: rules.join('\n') };
}
