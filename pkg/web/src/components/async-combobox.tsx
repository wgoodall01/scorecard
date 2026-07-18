import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export type ComboboxOption = { value: string; label: string };

// Single-select searchable combobox (shadcn Popover + Command) whose options
// arrive asynchronously: pass `options: null` while the fetch is in flight
// (the list shows a spinner), and `onOpen` fires on every open so the parent
// can (re)load and the palette is never stale.
export function AsyncCombobox({
  id,
  value,
  onValueChange,
  options,
  onOpen,
  placeholder = "Choose…",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches.",
  invalid = false,
}: {
  id?: string;
  value: string | null;
  onValueChange: (value: string) => void;
  options: ComboboxOption[] | null;
  onOpen?: () => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options?.find((option) => option.value === value) ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) onOpen?.();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span className={cn("truncate", !selected && "text-muted-foreground")}>
          {selected
            ? selected.label
            : value !== null && options === null
              ? "Loading…"
              : placeholder}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            {options === null ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Spinner />
                Loading…
              </div>
            ) : (
              <>
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                <CommandGroup>
                  {options.map((option) => (
                    <CommandItem
                      key={option.value}
                      value={option.label}
                      onSelect={() => {
                        onValueChange(option.value);
                        setOpen(false);
                      }}
                    >
                      <Check
                        aria-hidden="true"
                        className={cn(
                          "size-4",
                          option.value === value ? "opacity-100" : "opacity-0",
                        )}
                      />
                      {option.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
