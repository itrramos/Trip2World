/**
 * Presentational primitives now live in `@trip2world/ui` so the admin panel uses the
 * identical components. Re-exported here so existing imports keep working and there is
 * one obvious place to look from inside this app.
 */
export { AuthShell, Button, Field, FormError, Input, Select, cn } from '@trip2world/ui';
export type { ButtonProps, FieldProps } from '@trip2world/ui';
