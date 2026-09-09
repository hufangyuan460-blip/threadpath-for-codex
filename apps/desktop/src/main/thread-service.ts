import { ConfigurationError, type Thread, type ThreadSummary } from "../../../../threadpath-protocol/src/protocol.ts";

export interface ThreadClient {
  listThreads(): Promise<ThreadSummary[]>;
  readThread(threadId: string): Promise<Thread>;
}

export interface ThreadClientProvider {
  getReadyClient(): ThreadClient;
}

export interface ThreadListViewModel {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly turnCount: number | null;
  readonly createdAt?: string;
}

export interface ThreadViewModel extends ThreadListViewModel {}

export class ThreadService {
  private readonly clientProvider: ThreadClientProvider;

  constructor(clientProvider: ThreadClientProvider) {
    this.clientProvider = clientProvider;
  }

  async listThreads(): Promise<ThreadListViewModel[]> {
    const threads = await this.clientProvider.getReadyClient().listThreads();
    return threads.map((thread) => this.toViewModel(thread));
  }

  async readThread(threadId: unknown): Promise<ThreadViewModel> {
    const validThreadId = this.validateThreadId(threadId);
    const thread = await this.clientProvider.getReadyClient().readThread(validThreadId);
    return this.toViewModel(thread);
  }

  private toViewModel(thread: ThreadSummary | Thread): ThreadViewModel {
    const turns = "turns" in thread ? thread.turns : undefined;

    return {
      id: thread.id,
      title: thread.title?.trim() || "Untitled thread",
      status: thread.status?.trim() || "unknown",
      turnCount: turns === undefined ? thread.turnCount ?? null : turns.length,
      ...(thread.createdAt === undefined ? {} : { createdAt: thread.createdAt }),
    };
  }

  private validateThreadId(threadId: unknown): string {
    if (typeof threadId !== "string" || threadId.length === 0 || threadId !== threadId.trim() || threadId.length > 256 || /[\u0000-\u001f\u007f]/.test(threadId)) {
      throw new ConfigurationError("threadId must be a trimmed non-empty identifier of at most 256 characters");
    }
    return threadId;
  }
}
