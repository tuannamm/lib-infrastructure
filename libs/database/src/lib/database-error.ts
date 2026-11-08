/** Safe storage failure contract. Driver errors and credentials are not exposed. */
export class DatabaseError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;

  constructor(message = 'Database storage unavailable') {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class DatabaseValidationError extends Error {
  readonly code = 'VALIDATION_ERROR' as const;
  constructor() {
    super('Invalid database input');
    this.name = 'DatabaseValidationError';
  }
}

export class DatabaseConflictError extends Error {
  readonly code = 'DATABASE_CONFLICT' as const;
  constructor() {
    super('Database record already exists');
    this.name = 'DatabaseConflictError';
  }
}
