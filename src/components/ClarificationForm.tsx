import { Send } from "lucide-react";
import { useRef, useState } from "react";
import { clarificationAnswer, type ClarificationRequest } from "@common/clarification";

interface ClarificationFormProps {
  request: ClarificationRequest;
  disabled: boolean;
  onSubmit: (answer: string) => boolean;
}

export function ClarificationForm({ request, disabled, onSubmit }: ClarificationFormProps): React.ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const inactive = disabled || submitted;

  return (
    <form aria-label="Clarification questions" className="my-2 min-w-0 space-y-4 border-l-2 border-emerald-500 pl-4" onSubmit={(event) => {
      event.preventDefault();
      if (inactive || submitting.current) return;
      const answer = clarificationAnswer(request, answers);
      if (!answer) { setError("Answer each question before sending."); return; }
      submitting.current = true;
      try {
        if (onSubmit(answer)) { setSubmitted(true); setError(""); return; }
        else setError("Answers were not sent. Try again when chat is ready.");
      } catch {
        setError("Answers could not be sent. Your entries are still here.");
      }
      submitting.current = false;
    }}>
      <h3 className="break-words text-base font-semibold">{request.title}</h3>
      <fieldset disabled={inactive} className="min-w-0 space-y-4 disabled:opacity-60">
        {request.questions.map((question, index) => (
          <div key={question.id} className="min-w-0 space-y-1.5">
            <label className="block break-words text-sm">
              <span>{question.prompt}</span>
              {question.options ? (
                <select required className="mt-1.5 block w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={custom[question.id] ? "other" : answers[question.id] ? `choice-${question.options.indexOf(answers[question.id])}` : ""} onChange={(event) => {
                  const other = event.target.value === "other";
                  setCustom((previous) => ({ ...previous, [question.id]: other }));
                  setAnswers((previous) => ({ ...previous, [question.id]: other || !event.target.value ? "" : question.options![Number(event.target.value.slice(7))] }));
                }}>
                  <option value="">Select an answer</option>
                  {question.options.map((option, optionIndex) => <option key={option} value={`choice-${optionIndex}`}>{option}</option>)}
                  <option value="other">Other...</option>
                </select>
              ) : <input required maxLength={2000} autoComplete="off" className="mt-1.5 block w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))} />}
            </label>
            {question.options && custom[question.id] ? <input required maxLength={2000} aria-label={`Other answer for question ${index + 1}`} autoComplete="off" className="block w-full min-w-0 rounded-md border border-neutral-300 bg-white px-2 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={answers[question.id] ?? ""} onChange={(event) => setAnswers((previous) => ({ ...previous, [question.id]: event.target.value }))} /> : null}
          </div>
        ))}
        <button type="submit" className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"><Send size={15} aria-hidden="true" />{submitted ? "Answers sent" : "Send answers"}</button>
      </fieldset>
      {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </form>
  );
}