import * as React from 'react';
import { cn } from '../../lib/utils.js';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type, ...props },
  ref,
): React.JSX.Element {
  return <input type={type} ref={ref} className={cn('input', className)} {...props} />;
});
Input.displayName = 'Input';
