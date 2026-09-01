ALTER TYPE scope_name RENAME VALUE 'anytype.chats.write' TO 'anytype.chats.send';

ALTER TYPE scope_name ADD VALUE 'anytype.collections.read';
ALTER TYPE scope_name ADD VALUE 'anytype.files.read';
ALTER TYPE scope_name ADD VALUE 'publications.read';
