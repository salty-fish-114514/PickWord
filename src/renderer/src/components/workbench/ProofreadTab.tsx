import { Block, Switch } from "./shared";
import { Icon } from "../Icon";
import { ISSUE_KIND_LABEL, type Issue } from "../../lib/proofread";

export type ProofStatus =
  | { state: "idle" }
  | { state: "running"; chars: number }
  | { state: "done"; at: number; chars: number; ms: number; found: number }
  | { state: "error"; message: string };

export interface ProofreadTabProps {
  issues: Issue[];
  /** 光标所在的问题（编辑器算出来的），列表里高亮。 */
  activeIssueId: string | null;
  status: ProofStatus;
  /** 人设校验的状态（同一管线，独立计时）。 */
  consistencyStatus: ProofStatus;
  /** 建过角色卡才有东西可校验。 */
  hasCharacters: boolean;
  /** 模型已就绪（演示模式恒为 true）。 */
  ready: boolean;
  /** 模型就绪且槽位够用。 */
  available: boolean;
  slots: number;
  isDemo: boolean;
  auto: boolean;
  local: boolean;
  consistencyAuto: boolean;
  onAutoChange: (next: boolean) => void;
  onLocalChange: (next: boolean) => void;
  onConsistencyAutoChange: (next: boolean) => void;
  onCheckNow: () => void;
  onCheckConsistency: () => void;
  onCancel: () => void;
  onAccept: (issue: Issue) => void;
  onDismiss: (issue: Issue) => void;
  onLocate: (issue: Issue) => void;
  onClearAll: () => void;
}

function statusText(status: ProofStatus, verb = "检查", noun = "问题"): string {
  switch (status.state) {
    case "idle":
      return `还没有${verb}过。`;
    case "running":
      return `正在${verb} ${status.chars} 字…`;
    case "done": {
      const seconds = (status.ms / 1000).toFixed(1);
      const found = status.found === 0 ? `没有发现${noun}` : `发现 ${status.found} 处`;
      return `${formatAgo(status.at)}${verb}了 ${status.chars} 字，耗时 ${seconds} 秒，${found}。`;
    }
    case "error":
      return `${verb}失败：${status.message}`;
  }
}

function formatAgo(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

export function ProofreadTab({
  issues,
  activeIssueId,
  status,
  consistencyStatus,
  hasCharacters,
  ready,
  available,
  slots,
  isDemo,
  auto,
  local,
  consistencyAuto,
  onAutoChange,
  onLocalChange,
  onConsistencyAutoChange,
  onCheckNow,
  onCheckConsistency,
  onCancel,
  onAccept,
  onDismiss,
  onLocate,
  onClearAll,
}: ProofreadTabProps) {
  const running = status.state === "running";
  const checkingConsistency = consistencyStatus.state === "running";
  const llmIssues = issues.filter((issue) => issue.source === "llm");
  const localIssues = issues.filter((issue) => issue.source === "local");
  const needSlots = ready && !isDemo && slots < 2;

  return (
    <>
      <Block
        title="模型检查"
        action={
          running ? (
            <button className="quiet-button anchor-button" type="button" onClick={onCancel}>
              停止
            </button>
          ) : (
            <button className="quiet-button anchor-button" type="button" disabled={!available} onClick={onCheckNow}>
              <Icon name="check" />
              检查当前窗口
            </button>
          )
        }
      >
        <p className={`context-hint ${status.state === "error" ? "is-error" : ""}`}>
          {ready ? statusText(status) : "本地模型尚未就绪，就绪后即可检查。"}
        </p>
        {needSlots && (
          <p className="anchor-notice">
            本地模型只开了 {slots} 个槽位，检查会和候选抢上下文缓存。到首页「模型与推理」把「并行槽位」设为 2（上下文长度也相应翻倍）即可启用。
          </p>
        )}
        {isDemo && <p className="context-hint">演示模式：结果是示例，不代表模型的真实判断。</p>}
      </Block>

      <Block title="停笔后自动检查" action={<Switch checked={auto} label="自动检查" onChange={onAutoChange} />}>
        <p className="context-hint">停笔 3 秒、且比上次多写了 600 字以上时，自动检查新写的部分（正在写的那一段不查）。窗口起点固定，前缀缓存能复用。</p>
      </Block>

      <Block title="本地重复提示" action={<Switch checked={local} label="本地提示" onChange={onLocalChange} />}>
        <p className="context-hint">不花算力：短距离内重复的四字以上片段、连续几段同样的开头、和角色名只差一个字的罕见写法。人名本身不算重复。</p>
      </Block>

      <Block
        title="人设校验"
        action={
          checkingConsistency ? (
            <button className="quiet-button anchor-button" type="button" onClick={onCancel}>
              停止
            </button>
          ) : (
            <button
              className="quiet-button anchor-button"
              type="button"
              disabled={!available || !hasCharacters || running}
              title={hasCharacters ? "把这段正文和出现过的角色卡对一遍" : "先在「角色」页建卡"}
              onClick={onCheckConsistency}
            >
              <Icon name="person" />
              校验当前窗口
            </button>
          )
        }
      >
        <p className={`context-hint ${consistencyStatus.state === "error" ? "is-error" : ""}`}>
          {!hasCharacters
            ? "先在「角色」页建卡：模型会把正文和出现过的角色卡（背景 / 性格 / 外观 / 自定义项）对一遍，只报明确矛盾。"
            : statusText(consistencyStatus, "校验", "矛盾")}
        </p>
      </Block>

      <Block title="随纠错一起校验人设" action={<Switch checked={consistencyAuto} label="随纠错一起校验人设" onChange={onConsistencyAutoChange} />}>
        <p className="context-hint">
          每次纠错跑完，同一窗口再对一遍角色卡（{slots >= 3 || isDemo ? "有第 3 个槽位，和纠错并行" : "只有 2 个槽位，排在纠错后面"}）。
        </p>
      </Block>

      <Block
        title={issues.length === 0 ? "问题" : `问题 · 模型 ${llmIssues.length} · 本地 ${localIssues.length}`}
        action={
          issues.length > 0 ? (
            <button className="link-button" type="button" onClick={onClearAll}>
              全部清除
            </button>
          ) : undefined
        }
        last
      >
        {issues.length === 0 ? (
          <p className="context-hint">波浪线 = 语病 / 人设矛盾，底色 = 单调 / 重复。光标落在标记上时，底栏会显示说明。</p>
        ) : (
          <ul className="issue-list">
            {issues.map((issue) => (
              <li key={issue.id} className={`issue-card ${issue.id === activeIssueId ? "is-active" : ""}`} data-kind={issue.kind}>
                <div className="issue-head">
                  <span className="issue-kind" data-kind={issue.kind}>
                    {ISSUE_KIND_LABEL[issue.kind]}
                  </span>
                  <button className="issue-quote" type="button" title="定位到原文" onClick={() => onLocate(issue)}>
                    {issue.quote}
                  </button>
                  {issue.ranges.length > 1 && <span className="issue-count">×{issue.ranges.length}</span>}
                </div>
                <p className="issue-message">{issue.message}</p>
                {issue.suggestion && <p className="issue-suggestion">{issue.suggestion}</p>}
                <div className="card-actions">
                  {issue.suggestion && (
                    <button className="link-button" type="button" onClick={() => onAccept(issue)}>
                      采纳
                    </button>
                  )}
                  <button className="link-button" type="button" onClick={() => onLocate(issue)}>
                    定位
                  </button>
                  <button className="link-button" type="button" onClick={() => onDismiss(issue)}>
                    忽略
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Block>
    </>
  );
}
