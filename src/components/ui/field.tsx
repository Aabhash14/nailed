import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const control =
  "min-h-tap w-full rounded-control border border-line-strong bg-surface-raised px-3 py-2 text-base text-ink placeholder:text-ink-muted transition-[border-color,box-shadow] duration-(--motion-fast) ease-soft hover:border-ink focus-visible:border-primary aria-[invalid=true]:border-danger aria-[invalid=true]:border-2";

type Common = { label: ReactNode; hint?: string; error?: string | undefined };

function Wrap({
  id,
  label,
  hint,
  error,
  children,
  required,
}: Common & { id: string; children: ReactNode; required?: boolean | undefined }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold tracking-[0.01em]">
        {label}
        {required ? (
          <span className="text-danger"> *</span>
        ) : (
          <span className="text-ink-muted font-normal"> (optional)</span>
        )}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-ink-muted text-sm">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="text-danger text-sm font-semibold">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function describedBy(id: string, hint?: string, error?: string) {
  const ids = [hint ? `${id}-hint` : "", error ? `${id}-err` : ""].filter(Boolean).join(" ");
  return ids || undefined;
}

export function TextField({
  label,
  hint,
  error,
  required,
  className = "",
  ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} required={required}>
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={`${control} ${className}`}
        {...rest}
      />
    </Wrap>
  );
}

export function TextArea({
  label,
  hint,
  error,
  required,
  ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        rows={3}
        className={control}
        {...rest}
      />
    </Wrap>
  );
}

export function SelectField({
  label,
  hint,
  error,
  required,
  children,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error} required={required}>
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={control}
        {...rest}
      >
        {children}
      </select>
    </Wrap>
  );
}

export function CheckField({
  label,
  hint,
  ...rest
}: { label: ReactNode; hint?: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const id = useId();
  return (
    <div className="min-h-tap flex items-start gap-3 py-1">
      <input
        id={id}
        type="checkbox"
        aria-describedby={hint ? `${id}-hint` : undefined}
        className="accent-primary mt-0.5 h-5 w-5 shrink-0 cursor-pointer"
        {...rest}
      />
      <label htmlFor={id} className="cursor-pointer text-base">
        {label}
        {hint ? (
          <span id={`${id}-hint`} className="text-ink-muted block text-sm">
            {hint}
          </span>
        ) : null}
      </label>
    </div>
  );
}
