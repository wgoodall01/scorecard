import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Multi-value free-input combobox (shadcn Popover + Command): selected values
// render as removable badges, and the palette accepts both listed suggestions
// and arbitrary typed entries.
export function MultiCombobox({
  values,
  onChange,
  suggestions = [],
  placeholder = "Type to add…",
  addLabel = "Add",
  disabled = false,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  addLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const has = (value: string) =>
    values.some((entry) => entry.toLowerCase() === value.trim().toLowerCase());

  function add(value: string) {
    const trimmed = value.trim();
    if (trimmed && !has(trimmed)) onChange([...values, trimmed]);
    setQuery("");
    setOpen(false);
  }

  const available = suggestions.filter((suggestion) => !has(suggestion));
  const showAdd = query.trim().length > 0 && !has(query);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {values.map((value) => (
        <Badge key={value} variant="secondary" className="gap-1 pr-1">
          {value}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${value}`}
              className="rounded-full p-0.5 transition-colors hover:bg-foreground/10"
              onClick={() => onChange(values.filter((entry) => entry !== value))}
            >
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && (
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen) setQuery("");
          }}
        >
          <PopoverTrigger render={<Button type="button" variant="outline" size="sm" />}>
            <Plus data-icon="inline-start" />
            {addLabel}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <Command>
              <CommandInput value={query} onValueChange={setQuery} placeholder={placeholder} />
              <CommandList>
                <CommandEmpty>Type a new entry to add it.</CommandEmpty>
                {(showAdd || available.length > 0) && (
                  <CommandGroup>
                    {showAdd && (
                      <CommandItem key="__add__" value={query} onSelect={() => add(query)}>
                        Add “{query.trim()}”
                      </CommandItem>
                    )}
                    {available.map((suggestion) => (
                      <CommandItem
                        key={suggestion}
                        value={suggestion}
                        onSelect={() => add(suggestion)}
                      >
                        {suggestion}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
