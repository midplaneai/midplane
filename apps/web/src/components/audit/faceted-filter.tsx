"use client";

import { Check, ChevronDown } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A single-select facet (tenant / database / agent / token). The option hrefs
// are precomputed on the server by buildUrl — each one either selects that
// value or, if it's already active, clears the facet — so this component stays
// a thin client shell over the URL-state model: every choice is still a real
// navigation, shareable and refresh-safe. cmdk gives in-menu search so the
// list scales past a handful of values without turning the toolbar into a
// wall of chips.

export interface FacetOption {
  value: string;
  label: string;
  /** Precomputed URL that toggles this value (selects, or clears if active). */
  href: string;
}

export function FacetedFilter({
  label,
  allHref,
  options,
  selectedValue,
  selectedLabel,
}: {
  label: string;
  /** URL that clears this facet. */
  allHref: string;
  options: readonly FacetOption[];
  selectedValue: string | null;
  selectedLabel: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const active = selectedValue !== null;

  function go(href: string) {
    setOpen(false);
    router.push(href, { scroll: false });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            active ? `${label}: ${selectedLabel}` : `Filter by ${label}`
          }
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[3px] border px-2.5 text-xs transition-colors",
            active
              ? "border-border-strong bg-popover text-foreground"
              : "border-border bg-secondary text-subtle hover:border-border-strong hover:text-foreground",
          )}
        >
          <span className="font-mono text-[11.5px] lowercase tracking-[0.04em]">
            {label}
          </span>
          {active && (
            <>
              <span className="text-subtle" aria-hidden>
                ·
              </span>
              <span className="max-w-[140px] truncate font-mono font-medium text-foreground">
                {selectedLabel}
              </span>
            </>
          )}
          <ChevronDown className="h-3 w-3 text-subtle" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60" align="start">
        <Command>
          <CommandInput placeholder={`Filter ${label}…`} />
          <CommandList>
            <CommandEmpty>No {label} found.</CommandEmpty>
            <CommandGroup
              heading={`${options.length} ${label}${options.length === 1 ? "" : "s"}`}
            >
              <CommandItem value={`all ${label}`} onSelect={() => go(allHref)}>
                <Check
                  className={cn(
                    "h-3.5 w-3.5",
                    active ? "opacity-0" : "text-foreground",
                  )}
                  aria-hidden
                />
                <span className={active ? "text-subtle" : "text-foreground"}>
                  All {label}s
                </span>
              </CommandItem>
              {options.map((o) => {
                const isSelected = o.value === selectedValue;
                return (
                  <CommandItem
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => go(o.href)}
                  >
                    <Check
                      className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        isSelected ? "text-foreground" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="truncate">{o.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
