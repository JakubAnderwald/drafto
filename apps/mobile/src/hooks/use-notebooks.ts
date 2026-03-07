import { useState, useEffect } from "react";
import { Q } from "@nozbe/watermelondb";

import { database, Notebook } from "@/db";

export function useNotebooks() {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const subscription = database
      .get<Notebook>("notebooks")
      .query(Q.sortBy("updated_at", Q.desc))
      .observe()
      .subscribe((records) => {
        setNotebooks(records);
        setLoading(false);
      });

    return () => subscription.unsubscribe();
  }, []);

  return { notebooks, loading };
}
