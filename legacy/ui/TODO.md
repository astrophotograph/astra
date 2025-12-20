# TODO List

This document contains all TODO and XXX comments found in the codebase.

## Security Issues (High Priority)

### Client-side ID Modification Prevention
- **File:** `src/app/i/[id]/edit-image-form.tsx:36`
  - **Comment:** `id: image.id!, // todo : make sure this can't be modified from client!`
  - **Description:** Need to prevent client-side modification of image ID in form

- **File:** `src/app/c/[id]/edit-collection-form.tsx:35`
  - **Comment:** `id: collection.id, // todo : make sure this can't be modified from client!`
  - **Description:** Need to prevent client-side modification of collection ID in form

## Feature Enhancements (Medium Priority)

### File Handling Improvements
- **File:** `../alog.py:115`
  - **Comment:** `# todo : exclude hidden files, add "fits" extension`
  - **Description:** Need to filter out hidden files and ensure proper FITS file extension handling in manifest creation

### Catalog Pattern Matching
- **File:** `../alog.py:537`
  - **Comment:** `'Barnard': r'^B\s*(\d+)',  # Matches: B33, B 33, etc. TODO: tighten this up!`
  - **Description:** The regex pattern for Barnard catalog objects needs refinement

### Image Metadata Validation
- **File:** `src/components/image-viewer.tsx:190`
  - **Comment:** `// todo : ensure metadata is complete!  specifically dimensions!`
  - **Description:** Need to validate that image metadata contains complete dimension information

### Todo List Feature Enhancements
- **File:** `src/app/todo/page.tsx:5-8`
  - **Comments:**
    ```
    // todo:
    // - date to track when added and imaged.  (checkbox).  filter to show completed
    // - add notes on target
    // - write to database table after writing to local storage
    ```
  - **Description:** Multiple enhancements needed for the astronomy todo list functionality:
    - Add date tracking for when targets are added and imaged
    - Add checkbox functionality with completion filtering
    - Add notes field for targets
    - Implement database persistence instead of local storage

### Annotation Highlighting
- **File:** `src/components/annotation-card.tsx:74`
  - **Comment:** `// todo : when hovering on card, flag that object for highlighting in annotation!`
  - **Description:** Feature request to highlight objects in annotations when hovering over cards

## Code Quality Issues (Low Priority)

### Configuration Refactoring
- **File:** `src/lib/config.ts:1`
  - **Comment:** `// Hacky way of doing global settings...`
  - **Description:** Configuration approach needs refactoring to be less hacky

### Debug Code Cleanup
- **File:** `src/middleware.ts:8-21, 32-51`
  - **Description:** Multiple commented-out debug statements that should be cleaned up

## Summary

- **Total TODO items:** 8
- **Security issues:** 2
- **Feature enhancements:** 5
- **Code quality issues:** 2

Most critical items are the security-related TODOs that need to prevent client-side tampering with form IDs.