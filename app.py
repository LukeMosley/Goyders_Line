# app.py
"""
Goyder's Line – Stage 0 interactive map
"""

import streamlit as st
from streamlit_folium import st_folium
import folium
import geopandas as gpd
from pathlib import Path

st.set_page_config(
    page_title="Goyder's Line Explorer",
    page_icon="🌾",
    layout="wide",
)

st.title("Goyder's Line – South Australia")
st.markdown(
    """
    **Stage 0 prototype**  
    Official Goyder's Line (Department for Environment and Water) overlaid on an interactive map.  
    Next stages will add gridded rainfall, soil moisture and NDVI.
    """
)

# ---------- load data (cached) ----------
@st.cache_data
def load_goyders_line():
    geojson_path = Path("data/goyders_line_4326.geojson")
    if not geojson_path.exists():
        st.error("GeoJSON not found. Run convert_goyders_line.py first.")
        st.stop()
    gdf = gpd.read_file(geojson_path)
    return gdf

gdf = load_goyders_line()

# ---------- sidebar ----------
with st.sidebar:
    st.header("Layers")
    show_line = st.checkbox("Goyder's Line", value=True)
    st.markdown("---")
    st.caption("Data: SA Department for Environment and Water (GDA2020 → WGS84)")

# ---------- map ----------
# Reasonable SA centre / zoom for the whole line
m = folium.Map(
    location=[-33.5, 137.5],
    zoom_start=6,
    tiles="CartoDB positron",
    control_scale=True,
)

# Optional nicer basemap choices
folium.TileLayer("OpenStreetMap", name="OpenStreetMap").add_to(m)
folium.TileLayer(
    tiles="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr="Esri",
    name="Satellite",
).add_to(m)

if show_line:
    folium.GeoJson(
        gdf,
        name="Goyder's Line",
        style_function=lambda feature: {
            "color": "#8B0000",
            "weight": 4,
            "opacity": 0.95,
        },
        tooltip=folium.GeoJsonTooltip(
            fields=["OBJECTID"],
            aliases=["Segment ID"],
            sticky=True,
        ),
        highlight_function=lambda x: {"weight": 6, "color": "#FF4500"},
    ).add_to(m)

folium.LayerControl(collapsed=False).add_to(m)

# Render
st_folium(m, width=None, height=700, returned_objects=[])

# ---------- footer ----------
st.markdown("---")
st.caption(
    "Goyder's Line marks the approximate northern limit of reliable rainfall "
    "for cropping as assessed by Surveyor-General George Goyder in 1865 "
    "(~250–300 mm annual isohyet)."
)
