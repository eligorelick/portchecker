"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { shares, usd } from "~/app/_components/format";
import {
  addedMessage,
  holdingFormState,
  holdingFormText,
  MAX_SCREENSHOTS,
  previewChanges,
  previewLoader,
  previewSummary,
  rowCount,
  rowTextAfterChange,
  screenshotPickProblem,
} from "~/server/queue";
import { api, type RouterOutputs } from "~/trpc/react";

type Holding = RouterOutputs["holdings"]["list"][number];
type Parsed = RouterOutputs["holdings"]["parseCsv"];
type Preview = Parsed & { csv: string; fileName: string };

const holdingKey = (h: { ticker: string; accountLabel: string }) =>
  `${h.ticker}|${h.accountLabel}`;

function readImage(file: File) {
  return new Promise<{ name: string; dataUrl: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve({ name: file.name, dataUrl: reader.result as string });
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
}

export default function ImportPage() {
  const router = useRouter();
  const utils = api.useUtils();
  const holdings = api.holdings.list.useQuery();
  const files = api.holdings.importFiles.useQuery();
  const parse = api.holdings.parseCsv.useMutation();
  const readFile = api.holdings.readImportFile.useMutation();
  const importCsv = api.holdings.import.useMutation();
  const screenshots = api.holdings.parseScreenshots.useMutation();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadPreview] = useState(() =>
    previewLoader(
      (text: string) => parse.mutateAsync({ csv: text }),
      setPreview,
    ),
  );
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");

  /** Runs one file action and shows any failure beside the file buttons. */
  async function attempt(action: () => Promise<void>) {
    setProblem("");
    try {
      await action();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  }

  async function load(read: Parameters<typeof loadPreview>[0]) {
    setMessage("");
    await loadPreview(read);
  }

  async function confirm() {
    if (!preview) return;
    const { csv, fileName } = preview;
    try {
      const { imported } = await importCsv.mutateAsync({ csv, fileName });
      setPreview(null);
      setMessage(
        `Replaced your holdings with ${rowCount(imported)} from ${fileName}. Press Run research to review any new ones.`,
      );
      await utils.holdings.invalidate();
      router.refresh();
    } catch {
      // Shown under the button through importCsv.error.
    }
  }

  // What the replace would change, because it overwrites everything at once.
  const changes = useMemo(
    () => previewChanges(holdings.data, preview),
    [preview, holdings.data],
  );

  const busy = parse.isPending || readFile.isPending || screenshots.isPending;

  return (
    <div className="max-w-5xl space-y-8">
      {holdings.error && (
        <p role="alert" className="text-bad text-sm">
          Could not load holdings. {holdings.error.message}{" "}
          <button className="btn" onClick={() => void holdings.refetch()}>
            Retry
          </button>
        </p>
      )}
      {files.error && (
        <p role="alert" className="text-bad text-sm">
          Could not load import files. {files.error.message}{" "}
          <button className="btn" onClick={() => void files.refetch()}>
            Retry
          </button>
        </p>
      )}
      <header>
        <Link href="/holdings" className="text-muted hover:text-ink text-sm">
          ‹ Holdings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Update holdings
        </h1>
        <p className="text-muted mt-1 max-w-prose text-sm">
          Replace everything from an export, or change single rows by hand
          below. You see every row before anything is replaced.
        </p>
      </header>

      <section aria-labelledby="import-title" className="space-y-4">
        <h2 id="import-title" className="text-lg font-semibold">
          Replace from a file
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="sheet flex flex-col items-start gap-2 p-4">
            <h3 className="font-medium">Schwab export</h3>
            <p className="text-muted flex-1 text-sm">
              In Schwab, open Positions and choose Export. No AI is involved.
            </p>
            <label className="btn has-[:focus-visible]:outline-2">
              Choose CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) {
                    await attempt(() =>
                      load(async () => ({
                        csv: await file.text(),
                        fileName: file.name,
                      })),
                    );
                  }
                }}
              />
            </label>
          </div>
          <div className="sheet flex flex-col items-start gap-2 p-4">
            <h3 className="font-medium">Screenshots</h3>
            <p className="text-muted flex-1 text-sm">
              Up to {MAX_SCREENSHOTS} pictures of your positions from any
              broker. Your selected AI reads them, so check the numbers it
              finds.
            </p>
            <label className="btn has-[:focus-visible]:outline-2">
              Choose images
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.webp"
                multiple
                className="sr-only"
                onChange={async (e) => {
                  const picked = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (!picked.length) return;
                  await attempt(() =>
                    load(async (isCurrent) => {
                      const tooMany = screenshotPickProblem(picked.length);
                      if (tooMany) throw new Error(tooMany);
                      const images = await Promise.all(picked.map(readImage));
                      if (!isCurrent()) return null;
                      const read = await screenshots.mutateAsync({ images });
                      return read;
                    }),
                  );
                }}
              />
            </label>
          </div>
        </div>
        {files.data && files.data.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Or reuse a saved file:</span>
            {files.data.map((name) => (
              <button
                key={name}
                className="btn btn-small"
                onClick={() =>
                  attempt(() =>
                    load(async () => {
                      const { csv: text } = await readFile.mutateAsync({
                        name,
                      });
                      return { csv: text, fileName: name };
                    }),
                  )
                }
              >
                {name}
              </button>
            ))}
          </div>
        )}
        <div aria-live="polite" className="space-y-2 text-sm empty:hidden">
          {screenshots.isPending && <p>Reading the screenshots.</p>}
          {problem && <p className="text-bad">{problem}</p>}
          {message && <p className="text-ok font-medium">✓ {message}</p>}
        </div>

        {preview && !busy && (
          <div className="sheet space-y-4 p-4">
            {preview.error ? (
              <>
                <p className="text-bad text-sm">{preview.error}</p>
                <button className="btn" onClick={() => setPreview(null)}>
                  Close
                </button>
              </>
            ) : (
              <>
                <div>
                  <h3 className="font-semibold">
                    Check {rowCount(preview.rows.length)} from{" "}
                    {preview.fileName}
                  </h3>
                  <p className="text-muted mt-0.5 text-sm">
                    {previewSummary(changes, !!holdings.error)}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-muted text-xs">
                      <tr>
                        <th scope="col" className="py-1 pr-4 font-medium">
                          Ticker
                        </th>
                        <th scope="col" className="py-1 pr-4 font-medium">
                          Name
                        </th>
                        <th
                          scope="col"
                          className="py-1 pr-4 text-right font-medium"
                        >
                          Quantity
                        </th>
                        <th
                          scope="col"
                          className="py-1 pr-4 text-right font-medium"
                        >
                          Market value
                        </th>
                        <th
                          scope="col"
                          className="py-1 pr-4 text-right font-medium"
                        >
                          Total cost basis
                        </th>
                        <th scope="col" className="py-1 pr-4 font-medium">
                          Account
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          Change
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => {
                        const before = changes?.before.get(r.ticker);
                        const total = changes?.after.get(r.ticker);
                        const basis = changes?.basisChanges.get(r.ticker);
                        const previous = holdings.data?.find(
                          (h) => holdingKey(h) === holdingKey(r),
                        );
                        const accountBasisChanged =
                          previous && previous.costBasis !== r.costBasis;
                        return (
                          <tr
                            key={holdingKey(r)}
                            className="border-line border-t"
                          >
                            <td className="py-1 pr-4 font-medium">
                              {r.ticker}
                            </td>
                            <td className="py-1 pr-4">{r.name}</td>
                            <td className="py-1 pr-4 text-right">
                              {shares(r.quantity)}
                            </td>
                            <td className="py-1 pr-4 text-right">
                              {usd(r.marketValue)}
                            </td>
                            <td className="py-1 pr-4 text-right">
                              {usd(r.costBasis)}
                            </td>
                            <td className="py-1 pr-4">{r.accountLabel}</td>
                            <td className="py-1 whitespace-nowrap">
                              {!changes ? (
                                ""
                              ) : before === undefined ? (
                                <span className="text-ok">New</span>
                              ) : before !== total ? (
                                <span className="text-warn">
                                  {total === r.quantity ? "Was" : "Total was"}{" "}
                                  {shares(before)}
                                </span>
                              ) : (
                                ""
                              )}
                              {basis && (
                                <span className="text-warn block whitespace-normal">
                                  {accountBasisChanged
                                    ? "Account cost basis"
                                    : "Total cost basis"}
                                  :{" "}
                                  {usd(
                                    accountBasisChanged
                                      ? previous.costBasis
                                      : basis.before,
                                  )}{" "}
                                  →{" "}
                                  {usd(
                                    accountBasisChanged
                                      ? r.costBasis
                                      : basis.after,
                                  )}
                                  {basis.before === null &&
                                    basis.after === null &&
                                    !accountBasisChanged &&
                                    " (account details changed)"}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!!changes?.removed.length && (
                  <p className="notice bg-warn-soft text-warn">
                    These will be removed: {changes.removed.join(", ")}
                  </p>
                )}
                {!!changes?.losingBasis.length && (
                  <p className="notice bg-warn-soft text-warn">
                    Cost basis will be cleared for:{" "}
                    {changes.losingBasis.join(", ")}
                  </p>
                )}
                {preview.notes.length > 0 && (
                  <ul className="text-warn list-disc pl-5 text-sm">
                    {preview.notes.map((note, i) => (
                      <li key={`${note}|${i}`}>{note}</li>
                    ))}
                  </ul>
                )}
                {preview.skipped.length > 0 && (
                  <div className="text-muted text-sm">
                    <p>These rows will be left out:</p>
                    <ul className="list-disc pl-5">
                      {preview.skipped.map((s, i) => (
                        <li key={`${s.row}|${i}`}>
                          {s.row}: {s.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex flex-wrap gap-3">
                  <button
                    className="btn btn-primary"
                    disabled={importCsv.isPending || !changes}
                    onClick={confirm}
                  >
                    Replace my holdings with {rowCount(preview.rows.length)}
                  </button>
                  <button className="btn" onClick={() => setPreview(null)}>
                    Cancel
                  </button>
                </div>
                {importCsv.error && (
                  <p role="alert" className="text-bad text-sm">
                    {importCsv.error.message}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="edit-title" className="space-y-3">
        <div>
          <h2 id="edit-title" className="text-lg font-semibold">
            Change rows by hand
          </h2>
          <p className="text-muted text-sm">
            For cash and money market funds such as SWVXX, use ticker CASH and
            enter the dollar amount as the quantity.
          </p>
        </div>
        <div className="sheet">
          <div className="text-muted border-line hidden grid-cols-[4.5rem_minmax(0,1fr)_6.5rem_7rem_11rem_8.5rem] gap-2 border-b px-3 py-2 text-xs xl:grid">
            <span>Ticker</span>
            <span>Name</span>
            <span>Quantity</span>
            <span>Total cost basis ($)</span>
            <span>Account</span>
            <span />
          </div>
          <div className="divide-line divide-y">
            {holdings.data?.map((h) => (
              <HoldingForm key={holdingKey(h)} holding={h} />
            ))}
          </div>
          {holdings.data?.length === 0 && (
            <p className="text-muted px-3 py-3 text-sm">
              No holdings yet. Add your first one below.
            </p>
          )}
        </div>
        <div className="sheet p-1">
          <h3 className="px-2 pt-2 text-sm font-semibold">Add a holding</h3>
          <HoldingForm />
        </div>
      </section>
    </div>
  );
}

function HoldingForm({ holding }: { holding?: Holding }) {
  const router = useRouter();
  const utils = api.useUtils();
  const upsert = api.holdings.upsert.useMutation();
  const remove = api.holdings.delete.useMutation();
  const initial = holdingFormText(holding);
  const [ticker, setTicker] = useState(holding?.ticker ?? "");
  const [name, setName] = useState(initial.name);
  const [quantity, setQuantity] = useState(initial.quantity);
  const [costBasis, setCostBasis] = useState(initial.costBasis);
  const [account, setAccount] = useState(holding?.accountLabel ?? "");
  const [saved, setSaved] = useState(false);
  const [added, setAdded] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const [seen, setSeen] = useState(holding);
  const changed = rowTextAfterChange(seen, holding);
  if (changed) {
    setSeen(holding);
    setName(changed.name);
    setQuantity(changed.quantity);
    setCostBasis(changed.costBasis);
  }

  const form = holdingFormState({ ticker, name, quantity, costBasis }, holding);
  const { canSave, dirty } = form;

  async function save() {
    if (!canSave || form.quantity === null) return;
    let result;
    try {
      result = await upsert.mutateAsync({
        ticker,
        accountLabel: account,
        name,
        quantity: form.quantity,
        costBasis: form.costBasis,
        adding: !holding,
      });
    } catch {
      return; // Shown under the row through upsert.error.
    }
    await utils.holdings.invalidate();
    router.refresh();
    if (holding) {
      setSaved(true);
    } else {
      setTicker("");
      setName("");
      setQuantity("");
      setCostBasis("");
      setAccount("");
      setAdded(addedMessage(result.ticker, result.otherRows));
    }
  }

  const label = "text-muted block text-xs";
  // Phones keep 16px text, which stops the browser zooming in when a field gets focus.
  const field = "field mt-0.5 xl:min-h-8 xl:py-0.5 xl:text-sm";
  const hide = holding ? "xl:sr-only" : "";
  const rowName = holding
    ? `${holding.ticker}${holding.accountLabel ? ` in ${holding.accountLabel}` : ""}`
    : "";
  return (
    <form
      className={`grid grid-cols-2 items-center gap-2 px-3 py-2 xl:grid-cols-[4.5rem_minmax(0,1fr)_6.5rem_7rem_11rem_8.5rem] ${
        holding ? "" : "items-end px-2"
      }`}
      onSubmit={async (e) => {
        e.preventDefault();
        await save();
      }}
      onChange={() => {
        setSaved(false);
        setAdded("");
        if (upsert.error) upsert.reset();
      }}
    >
      {holding ? (
        <p className="text-sm font-semibold">{holding.ticker}</p>
      ) : (
        <label className={label}>
          Ticker
          <input
            className={`${field} uppercase`}
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
          />
        </label>
      )}
      <label className={label}>
        <span className={hide}>Name</span>
        <input
          className={field}
          aria-label={holding ? `Name of ${holding.ticker}` : undefined}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className={label}>
        <span className={hide}>Quantity</span>
        <input
          className={field}
          inputMode="decimal"
          aria-label={holding ? `Quantity of ${holding.ticker}` : undefined}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </label>
      <label className={label}>
        <span className={hide}>Total cost basis ($)</span>
        <input
          className={field}
          inputMode="decimal"
          aria-label={
            holding ? `Total cost basis of ${holding.ticker}` : undefined
          }
          value={costBasis}
          onChange={(e) => setCostBasis(e.target.value)}
        />
      </label>
      {holding ? (
        <p className="text-muted truncate text-sm" title={holding.accountLabel}>
          {holding.accountLabel || "No account"}
        </p>
      ) : (
        <label className={label}>
          Account
          <input
            className={field}
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
        </label>
      )}
      <div className="col-span-2 flex flex-wrap items-center gap-2 xl:col-span-1">
        {confirmingDelete && holding ? (
          <>
            <button
              className="btn btn-small btn-danger"
              type="button"
              aria-label={`Delete ${rowName}`}
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({
                    ticker: holding.ticker,
                    accountLabel: holding.accountLabel,
                  });
                } catch {
                  return; // Shown under the row through remove.error.
                }
                await utils.holdings.invalidate();
                router.refresh();
              }}
            >
              Delete {holding.ticker}
            </button>
            <button
              className="btn btn-small"
              type="button"
              autoFocus
              aria-label={`Keep ${rowName}`}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <>
            {(!holding || dirty) && (
              <button
                className={`btn btn-small ${holding ? "btn-primary" : ""}`}
                type="submit"
                aria-label={holding ? `Save ${rowName}` : undefined}
                disabled={!canSave || upsert.isPending}
              >
                {holding ? "Save" : "Add holding"}
              </button>
            )}
            {holding && !dirty && saved && (
              <span className="text-ok text-sm">✓ Saved</span>
            )}
            {holding && (
              <button
                className="btn btn-small text-muted ml-auto"
                type="button"
                aria-label={`Delete ${rowName}`}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {(form.problem ?? upsert.error ?? remove.error) && (
        <p role="alert" className="text-bad col-span-full text-sm">
          {form.problem ?? (upsert.error ?? remove.error)?.message}
        </p>
      )}
      {added && <p className="text-ok col-span-full text-sm">✓ {added}</p>}
    </form>
  );
}
