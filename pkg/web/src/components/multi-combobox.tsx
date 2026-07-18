import { Fragment, useMemo, useState } from "react";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";

// Multi-value free-input combobox: ONE input styled like every other Input,
// with the selected values as removable chips inside it (Base UI Combobox in
// `multiple` mode, popup anchored to the chips container). Listed suggestions
// filter as you type, and anything new gets an Add “…” item at the top —
// values are case-insensitively unique.
export function MultiCombobox({
  values,
  onChange,
  suggestions = [],
  placeholder = "Type to add…",
  disabled = false,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
}) {
  const anchor = useComboboxAnchor();
  const [query, setQuery] = useState("");

  const trimmed = query.trim();
  const known = useMemo(
    () => new Set([...values, ...suggestions].map((entry) => entry.toLowerCase())),
    [values, suggestions],
  );
  const creatable = trimmed !== "" && !known.has(trimmed.toLowerCase()) ? trimmed : null;

  const items = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of [...(creatable ? [creatable] : []), ...suggestions, ...values]) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(item);
    }
    return list;
  }, [creatable, suggestions, values]);

  return (
    <Combobox
      multiple
      autoHighlight
      disabled={disabled}
      items={items}
      value={values}
      onValueChange={(next) => onChange(next as string[])}
      inputValue={query}
      onInputValueChange={setQuery}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {(selected: string[]) => (
            <Fragment>
              {selected.map((value) => (
                <ComboboxChip key={value} showRemove={!disabled}>
                  {value}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput
                placeholder={selected.length === 0 ? placeholder : undefined}
                disabled={disabled}
              />
            </Fragment>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>Type a new entry to add it.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => (
            <ComboboxItem key={item} value={item}>
              {item === creatable ? <>Add “{item}”</> : item}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
