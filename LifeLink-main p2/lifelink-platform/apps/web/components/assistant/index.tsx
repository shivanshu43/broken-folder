"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useState } from "react";
import { ApiFailure, requestApi } from "../../lib/api-client";

interface AssistantSource {
  sourceKey: string;
  title: string;
  similarity: number;
}
interface Handoff {
  label: string;
  href: string;
  reason: string;
}
interface AssistantResult {
  answer: string;
  intent: string;
  knowledgeUsed: boolean;
  liveDataUsed: boolean;
  sources: AssistantSource[];
  limitations: string[];
  handoff?: Handoff;
  answeredAt?: string;
}
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  result?: AssistantResult;
  failed?: boolean;
}

const starters = [
  "How does the blood request workflow work?",
  "What happens after an organ-coordination match is shortlisted?",
  "Find nearby blood donation centres in Indore, near Vijay Nagar.",
  "What does LifeLink do when no blood request matches are found?",
];

export function AssistantPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(value: string) {
    const message = value.trim();
    if (!message || pending) return;
    const history = messages.slice(-8).map(({ role, content }) => ({ role, content }));
    setMessages((current) => [...current, { role: "user", content: message }]);
    setDraft("");
    setPending(true);
    setError(null);
    try {
      const result = await requestApi<AssistantResult>("/api/rag/query", {
        method: "POST",
        body: JSON.stringify({ message, history }),
      });
      setMessages((current) => [...current, { role: "assistant", content: result.answer, result }]);
    } catch (cause) {
      const detail = cause instanceof ApiFailure
        ? cause.message
        : "The assistant could not reach LifeLink. Please try again.";
      setMessages((current) => [...current, {
        role: "assistant",
        content: detail,
        failed: true,
      }]);
      setError(detail);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(draft);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (draft.trim()) void sendMessage(draft);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-slate-50 px-5 py-4">
        <div>
          <h2 className="font-semibold text-slate-900">Ask LifeLink</h2>
          <p className="mt-1 text-xs leading-5 text-slate-600">
            Answers are grounded in approved documents. Live information is labelled when checked.
          </p>
        </div>
        <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">RAG enabled</span>
      </div>

      <div className="space-y-5 px-4 py-5 sm:px-5" aria-live="polite">
        {messages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 p-5">
            <p className="font-medium text-slate-900">What would you like to know?</p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              I can explain LifeLink's documented workflows and check current registered inventory or facility records when the question needs live data.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {starters.map((starter) => (
                <button
                  type="button"
                  key={starter}
                  onClick={() => void sendMessage(starter)}
                  disabled={pending}
                  className="rounded-full border border-slate-200 bg-white px-3 py-2 text-left text-sm text-slate-700 transition hover:border-slate-400 hover:bg-slate-100 disabled:opacity-50"
                >
                  {starter}
                </button>
              ))}
            </div>
          </div>
        ) : messages.map((message, index) => (
          <article key={`${index}-${message.role}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`w-full max-w-3xl rounded-2xl px-4 py-3 ${
              message.role === "user"
                ? "ml-8 bg-slate-900 text-white sm:ml-16"
                : "mr-2 border border-slate-200 bg-white text-slate-800"
            }`}>
              <p className="whitespace-pre-wrap text-sm leading-6">{message.content}</p>

              {message.result && (
                <div className="mt-3 space-y-3 border-t border-slate-200/70 pt-3">
                  <div className="flex flex-wrap gap-2">
                    {message.result.knowledgeUsed && <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-800">Approved documentation</span>}
                    {message.result.liveDataUsed && <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">Live LifeLink records checked</span>}
                    {message.result.intent === "MEDICAL_OR_CLINICAL" && <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">Clinical limitation</span>}
                  </div>

                  {message.result.sources?.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Sources used</p>
                      <div className="flex flex-wrap gap-2">
                        {message.result.sources.map((source) => (
                          <span key={source.sourceKey} title={`Retrieval relevance ${source.similarity.toFixed(3)}`} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs text-slate-700">
                            {source.title}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {message.result.handoff && (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs leading-5 text-slate-600">{message.result.handoff.reason}</p>
                      <Link href={message.result.handoff.href} className="mt-2 inline-flex items-center rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
                        {message.result.handoff.label}
                        <span aria-hidden="true" className="ml-2">→</span>
                      </Link>
                    </div>
                  )}

                  {message.result.limitations?.length > 0 && (
                    <details className="text-xs text-slate-500">
                      <summary className="cursor-pointer">Important limitations</summary>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {message.result.limitations.map((limitation, limitationIndex) => <li key={limitationIndex}>{limitation}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </div>
          </article>
        ))}

        {pending && (
          <div className="flex justify-start">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Checking approved knowledge and relevant LifeLink records…
            </div>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
      </div>

      <form onSubmit={handleSubmit} className="border-t border-slate-200 bg-slate-50 p-4 sm:p-5">
        <label htmlFor="lifelink-assistant-message" className="sr-only">Ask a LifeLink question</label>
        <div className="flex items-end gap-3">
          <textarea
            id="lifelink-assistant-message"
            rows={2}
            maxLength={2000}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about a workflow, policy, request status, or nearby facility…"
            className="min-h-12 flex-1 resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
          />
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            className="rounded-xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send"}
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">Enter to send · Shift+Enter for a new line. Don't include passwords or private medical documents.</p>
      </form>
    </section>
  );
}

export function AssistantMessage() {
  return <AssistantPanel />;
}
