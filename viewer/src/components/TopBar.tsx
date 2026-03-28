interface Props {
  username: string | null;
}

export function TopBar({ username }: Props) {
  return (
    <div class="topbar">
      <a href="https://astra.gallery" class="wordmark">
        astra.gallery
      </a>
      {username && (
        <a href={`/@${username}/`} class="user-link">
          @{username}
        </a>
      )}
    </div>
  );
}
