# AGENTS.md

## Project Overview
This is the Astra Astronomy Observation Log project, a full-stack application for tracking and organizing astronomy imaging sessions. It includes:
- Frontend: React + TypeScript with TailwindCSS
- Backend: Python utilities (SIMBAD lookups, altitude calculations, plate solving)
- CLI tools for image management

## Build/Lint/Test Commands

### Frontend (React/TypeScript)
```bash
# Install dependencies
pnpm install

# Development server
pnpm dev

# Build for production
pnpm build

# Run tests (if applicable)
pnpm test

# Linting
pnpm run lint
pnpm run format
```

### Python Backend
```bash
# Install Python dependencies 
cd python && uv sync

# Run specific Python test file
cd python && uv run pytest tests/test_module.py::test_function_name -v

# Run all Python tests
cd python && uv run pytest tests/ -v

# Linting with ruff
cd python && uv run ruff check .
cd python && uv run ruff format .

# Type checking with mypy (if configured)
cd python && uv run mypy src/
```

## Code Style Guidelines

### JavaScript/TypeScript Frontend
- **Imports**: Use absolute paths with `@/*` alias for `src/`
- **Naming Conventions**:
  - PascalCase for components and types
  - camelCase for functions and variables
  - UPPER_CASE for constants
- **Formatting**: Prettier via ESLint (configured in package.json)
- **Type Safety**: Strong typing with TypeScript interfaces and types
- **Error Handling**: Use React's error boundaries and proper try/catch blocks

### Python Backend
- **Imports**: Standard library first, then third-party, then local imports
- **Naming Conventions**:
  - snake_case for functions and variables
  - PascalCase for classes
  - UPPER_CASE for constants
- **Formatting**: Ruff with line-length=100 (configured in pyproject.toml)
- **Type Hints**: Full type hints using Python's typing module
- **Documentation**: Docstrings following Google style
- **Error Handling**: Use try/except blocks and proper exception raising

### General Guidelines
- **Commit Messages**: Follow conventional commits format
- **Code Comments**: Minimal, focused on "why" not "what"
- **Branching Strategy**: Feature branches with descriptive names
- **Testing**: Write unit tests for all new functionality