"use client";

import { useMemo, useState } from "react";
import type { EventItem } from "@/types/site";
import { EventCard } from "@/components/EventCard";

interface FestivalProgramExplorerProps {
  events: EventItem[];
  emptyStateText?: string;
  showSearch?: boolean;
}

export function FestivalProgramExplorer({
  events,
  emptyStateText = "No events match this filter.",
  showSearch = true,
}: FestivalProgramExplorerProps) {
  const [selectedGenre, setSelectedGenre] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const genres = useMemo(() => {
    const list = new Set<string>();
    for (const e of events) {
      if (e.genre) list.add(e.genre);
    }
    return ["ALL", ...Array.from(list)];
  }, [events]);

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const matchesGenre =
        selectedGenre === "ALL" ||
        e.genre?.toLowerCase() === selectedGenre.toLowerCase();
      const matchesSearch =
        !searchQuery.trim() ||
        e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.venue.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.location.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.genre?.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesGenre && matchesSearch;
    });
  }, [events, selectedGenre, searchQuery]);

  return (
    <div className="festival-program-explorer">
      <div className="festival-filter-bar">
        <div className="festival-genre-pills" role="tablist" aria-label="Festival genres">
          {genres.map((genre) => {
            const isActive = selectedGenre === genre;
            const count =
              genre === "ALL"
                ? events.length
                : events.filter(
                    (e) => e.genre?.toLowerCase() === genre.toLowerCase()
                  ).length;

            return (
              <button
                key={genre}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`festival-pill${isActive ? " is-active" : ""}`}
                onClick={() => setSelectedGenre(genre)}
              >
                <span>{genre === "ALL" ? "All Program" : genre}</span>
                <span className="festival-pill-count">{count}</span>
              </button>
            );
          })}
        </div>

        {showSearch && (
          <div className="festival-search-wrap">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search acts, venues, dates..."
              aria-label="Search festival program"
              className="festival-search-input"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="festival-search-clear"
                aria-label="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      <div className="festival-program-header">
        <span className="festival-program-count">
          Showing <strong>{filteredEvents.length}</strong> {filteredEvents.length === 1 ? "act" : "acts"}
        </span>
        {selectedGenre !== "ALL" && (
          <button
            type="button"
            className="festival-reset-btn"
            onClick={() => setSelectedGenre("ALL")}
          >
            Show all genres ↺
          </button>
        )}
      </div>

      {filteredEvents.length > 0 ? (
        <div className="events-grid">
          {filteredEvents.map((event, index) => (
            <EventCard key={event.id} event={event} priority={index === 0} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p>{emptyStateText}</p>
          {(selectedGenre !== "ALL" || searchQuery) && (
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setSelectedGenre("ALL");
                setSearchQuery("");
              }}
              style={{ marginTop: "16px" }}
            >
              Reset filters
            </button>
          )}
        </div>
      )}
    </div>
  );
}
