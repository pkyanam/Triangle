import * as React from 'react';
import { cn } from '../../lib/utils.js';

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <div ref={ref} className={cn('card', className)} {...props} />;
});
Card.displayName = 'Card';

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardHeader(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <div ref={ref} className={cn('card-header', className)} {...props} />;
});
CardHeader.displayName = 'CardHeader';

export const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(function CardTitle(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <h3 ref={ref} className={cn('card-title', className)} {...props} />;
});
CardTitle.displayName = 'CardTitle';

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardContent(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <div ref={ref} className={cn('card-content', className)} {...props} />;
});
CardContent.displayName = 'CardContent';

export const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardFooter(
  { className, ...props },
  ref,
): React.JSX.Element {
  return <div ref={ref} className={cn('card-footer', className)} {...props} />;
});
CardFooter.displayName = 'CardFooter';
