import { AssistantPanel } from "../../../components/assistant";

export default function AssistantPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">LifeLink</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">Smart FAQ Assistant</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          Ask about LifeLink workflows, policies, or registered facilities. Answers distinguish approved documentation from live operational records.
        </p>
      </div>
      <AssistantPanel />
    </main>
  );
}
