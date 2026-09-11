import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Receipt } from "ramose/client";
import { useReceipt } from "ramose/react";

type Notice = { readonly receipt: Receipt; readonly label: string };
type Track = (receipt: Receipt, label: string) => Receipt;
const Feedback = createContext<Track | undefined>(undefined);

export const useMutationFeedback = (): Track => {
  const track = useContext(Feedback);
  if (track === undefined) throw new Error("Mutation feedback needs its provider");
  return track;
};

const MutationNotice = ({ notice, dismiss }: { readonly notice: Notice; readonly dismiss: (id: string) => void }) => {
  const state = useReceipt(notice.receipt);
  const id = notice.receipt.invocation;
  useEffect(() => {
    if (state.status !== "committed") return;
    const timer = setTimeout(() => dismiss(id), 3000);
    return () => clearTimeout(timer);
  }, [state.status, dismiss, id]);
  const failed = state.status === "failed" || state.status === "rejected";
  const message = state.status === "rejected" ? "This change was rejected and has not been saved"
    : state.status === "failed" ? "Could not save this change on this device"
    : state.status === "committed" ? "Saved"
    : state.status === "queued" ? "Saved on this device; waiting to sync"
    : "Saving on this device…";
  return (
    <div className={failed ? "error" : "hint"} role={failed ? "alert" : "status"}>
      <strong>{notice.label}</strong>: {message}
      <button className="ghost" aria-label={`Dismiss ${notice.label}`} onClick={() => dismiss(id)}>✕</button>
    </div>
  );
};

export const MutationFeedbackProvider = ({ children }: { readonly children: ReactNode }) => {
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const track = useCallback<Track>((receipt, label) => {
    setNotices((current) => current.some((item) => item.receipt.invocation === receipt.invocation)
      ? current : [...current, { receipt, label }]);
    return receipt;
  }, []);
  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((item) => item.receipt.invocation !== id));
  }, []);
  return (
    <Feedback.Provider value={track}>
      {children}
      <aside className="mutation-feedback" aria-label="Save activity">
        {notices.map((notice) => <MutationNotice key={notice.receipt.invocation} notice={notice} dismiss={dismiss} />)}
      </aside>
    </Feedback.Provider>
  );
};
