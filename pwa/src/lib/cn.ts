import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Объединение классов с разрешением конфликтов Tailwind.
 * Нужен, чтобы переопределения в компоненте гарантированно побеждали
 * базовые классы (например, добавить свой padding к общему компоненту).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}