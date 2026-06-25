import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils.js';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export const SelectTrigger = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>>(
  function SelectTrigger({ className, children, ...props }, ref): React.JSX.Element {
    return (
      <SelectPrimitive.Trigger ref={ref} className={cn('select-trigger', className)} {...props}>
        {children}
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="select-chevron" size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  },
);
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Content>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>>(
  function SelectContent({ className, children, position = 'popper', ...props }, ref): React.JSX.Element {
    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          ref={ref}
          className={cn('select-content', position === 'popper' && 'select-content--popper', className)}
          position={position}
          sideOffset={4}
          {...props}
        >
          <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    );
  },
);
SelectContent.displayName = 'SelectContent';

export const SelectItem = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Item>, React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>>(
  function SelectItem({ className, children, ...props }, ref): React.JSX.Element {
    return (
      <SelectPrimitive.Item ref={ref} className={cn('select-item', className)} {...props}>
        <span className="select-item-indicator">
          <SelectPrimitive.ItemIndicator>
            <Check size={12} />
          </SelectPrimitive.ItemIndicator>
        </span>
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      </SelectPrimitive.Item>
    );
  },
);
SelectItem.displayName = 'SelectItem';
