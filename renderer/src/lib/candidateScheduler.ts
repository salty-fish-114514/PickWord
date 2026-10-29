/**
 * 候选请求调度：防抖 + 单飞 + 最新优先。与 React 无关，WritingEditor 用 ref 持有一个实例。
 *
 * 为什么要「单飞」：AbortSignal 过不了 IPC，renderer 侧 abort 只是「不再等结果」，
 * 主进程和 llama-server 并不知道，请求会在后端排队堆积。
 * 所以这里保证：任何时刻最多 1 个请求在飞 + 最多 1 个任务排队（永远只保留最新的）。
 * 后端若支持取消，则在新任务到来时顺手 abort 在飞请求，让后端尽早停下。
 *
 * 竞态判定交给调用方：runner 拿到 controller 后，在结果回来时用 isCurrent(controller)
 * 判断自己是否仍是「最新一次请求」，不是就丢弃结果。
 */
import type { SelectionRange } from "./types";

/** 一次候选请求的「任务描述」：正文快照 + 光标 + 当时是不是快速模式。 */
export interface CandidateJob {
  text: string;
  range: SelectionRange;
  quick: boolean;
}

export type CandidateJobRunner = (job: CandidateJob, controller: AbortController) => Promise<void>;

export class CandidateScheduler {
  private timer: number | null = null;
  private inFlight: AbortController | null = null;
  private pending: CandidateJob | null = null;
  private runner: CandidateJobRunner = async () => undefined;

  constructor(private readonly supportsCancel: boolean) {}

  /** 每次渲染更新一次，保证调用的是持有最新 state setter 的闭包。 */
  setRunner(runner: CandidateJobRunner): void {
    this.runner = runner;
  }

  /** 等 delayMs 后入队；期间再次 schedule 会重新计时（作者还在打字）。 */
  schedule(job: CandidateJob, delayMs: number): void {
    this.clearTimer();
    this.pending = null;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.enqueue(job);
    }, delayMs);
  }

  /** 停掉计时器、丢弃排队任务、中断在飞请求。 */
  cancel(): void {
    this.clearTimer();
    this.pending = null;
    if (this.inFlight) {
      this.inFlight.abort();
      this.inFlight = null;
    }
  }

  /** 该 controller 是否仍是当前在飞请求（且未被取消）。 */
  isCurrent(controller: AbortController): boolean {
    return this.inFlight === controller && !controller.signal.aborted;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 入队：在飞则排队（覆盖旧排队任务），否则立刻发。 */
  private enqueue(job: CandidateJob): void {
    if (this.inFlight) {
      this.pending = job;
      if (this.supportsCancel) this.inFlight.abort();
      return;
    }
    this.run(job);
  }

  private run(job: CandidateJob): void {
    const controller = new AbortController();
    this.inFlight = controller;
    void this.runner(job, controller)
      .catch(() => undefined)
      .finally(() => {
        if (this.inFlight === controller) this.inFlight = null;
        // 只有在「现在没有别的请求在飞」时才启动排队任务，保证单飞。
        if (this.inFlight === null && this.pending) {
          const next = this.pending;
          this.pending = null;
          this.run(next);
        }
      });
  }
}
