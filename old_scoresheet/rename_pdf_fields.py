#!/usr/bin/env python3
"""
PDF Form Field Renamer for Hierarchical Fields
Handles parent fields and their children (field#0, field#1, etc.)
"""

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject
import sys
import shutil

def rename_field_recursive(field_obj, old_text, new_text, path="", renamed_fields=None):
    """
    Recursively rename a field and all its children
    """
    if renamed_fields is None:
        renamed_fields = []
    
    # Rename the current field's /T (partial name)
    if "/T" in field_obj:
        old_name = str(field_obj["/T"])
        if old_text in old_name:
            new_name = old_name.replace(old_text, new_text)
            field_obj[NameObject("/T")] = TextStringObject(new_name)
            full_path = f"{path}.{old_name}" if path else old_name
            renamed_fields.append((full_path, old_name, new_name))
    
    # Process children if they exist
    if "/Kids" in field_obj:
        kids = field_obj["/Kids"]
        current_name = str(field_obj.get("/T", ""))
        new_path = f"{path}.{current_name}" if path else current_name
        
        for kid in kids:
            kid_obj = kid.get_object()
            rename_field_recursive(kid_obj, old_text, new_text, new_path, renamed_fields)
    
    return renamed_fields

def rename_fields_by_position(input_pdf, output_pdf, start_pos=232, end_pos=255, old_text="set1", new_text="set2"):
    """
    Rename PDF form fields and their children based on position in the fields array.
    """
    reader = PdfReader(input_pdf)
    writer = PdfWriter()
    writer.append(reader)
    
    if "/AcroForm" not in writer._root_object:
        print("No form fields found!")
        return
    
    acro_form = writer._root_object["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return
    
    fields_array = acro_form["/Fields"]
    total_fields = len(fields_array)
    
    print(f"\nTotal top-level fields: {total_fields}")
    print(f"Renaming fields in positions {start_pos} to {end_pos} containing '{old_text}' → '{new_text}'")
    print("(This includes parent fields and all their children)\n")
    
    # Convert to 0-indexed
    start_idx = start_pos - 1
    end_idx = min(end_pos - 1, total_fields - 1)
    
    if start_idx >= total_fields:
        print(f"Error: Starting position {start_pos} is beyond the total number of fields ({total_fields})")
        return
    
    all_renamed = []
    
    for idx in range(start_idx, end_idx + 1):
        field_obj = fields_array[idx].get_object()
        
        # Get the field name for display
        field_name = str(field_obj.get("/T", f"Field{idx+1}"))
        
        # Rename this field and all its children recursively
        renamed = rename_field_recursive(field_obj, old_text, new_text)
        
        if renamed:
            print(f"\nPosition {idx + 1}: {field_name}")
            for full_path, old_name, new_name in renamed:
                print(f"  '{old_name}' → '{new_name}'")
            all_renamed.extend(renamed)
    
    if all_renamed:
        temp_pdf = output_pdf + ".tmp"
        with open(temp_pdf, "wb") as output_file:
            writer.write(output_file)
        shutil.move(temp_pdf, output_pdf)
        print(f"\n{'='*60}")
        print(f"✓ Successfully renamed {len(all_renamed)} field(s) (including children)")
        print(f"✓ File saved: {output_pdf}")
        print(f"{'='*60}")
    else:
        print(f"\n✗ No fields were renamed.")

def count_all_fields(field_obj, count=0):
    """Count a field and all its children recursively"""
    count += 1
    if "/Kids" in field_obj:
        for kid in field_obj["/Kids"]:
            count = count_all_fields(kid.get_object(), count)
    return count

def list_all_fields_recursive(field_obj, indent=0, path=""):
    """List a field and all its children recursively"""
    if "/T" in field_obj:
        name = str(field_obj["/T"])
        full_path = f"{path}.{name}" if path else name
        print(f"{'  ' * indent}{name}")
        
        if "/Kids" in field_obj:
            for kid in field_obj["/Kids"]:
                list_all_fields_recursive(kid.get_object(), indent + 1, full_path)

def list_all_fields(input_pdf):
    """List all form fields with hierarchy"""
    reader = PdfReader(input_pdf)
    
    if "/Root" not in reader.trailer or "/AcroForm" not in reader.trailer["/Root"]:
        print("No form fields found in the PDF!")
        return
    
    acro_form = reader.trailer["/Root"]["/AcroForm"]
    if "/Fields" not in acro_form:
        print("No fields array found!")
        return
    
    fields_array = acro_form["/Fields"]
    
    print(f"\nTotal top-level fields: {len(fields_array)}")
    
    # Count all fields including children
    total_with_children = 0
    for field in fields_array:
        total_with_children = count_all_fields(field.get_object(), total_with_children)
    
    print(f"Total fields (including children): {total_with_children}\n")
    print(f"{'Position':<10} {'Field Hierarchy':<50}")
    print("-" * 60)
    
    for idx in range(len(fields_array)):
        field_obj = fields_array[idx].get_object()
        print(f"{idx + 1:<10}", end="")
        list_all_fields_recursive(field_obj)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage:")
        print("  Rename fields (overwrites file):")
        print("    python rename_pdf_fields3.py input.pdf [start_pos] [end_pos] [old_text] [new_text]")
        print()
        print("  List all fields with hierarchy:")
        print("    python rename_pdf_fields3.py input.pdf --list")
        print()
        print("Examples:")
        print("  python rename_pdf_fields3.py form.pdf 232 255 set1 set2")
        print("  python rename_pdf_fields3.py form.pdf --list")
        sys.exit(1)
    
    input_file = sys.argv[1]
    
    if len(sys.argv) >= 3 and sys.argv[2] == "--list":
        list_all_fields(input_file)
    else:
        # Default values
        start = 232
        end = 255
        old = "set1"
        new = "set2"
        
        # Override with command line arguments if provided
        if len(sys.argv) > 2:
            start = int(sys.argv[2])
        if len(sys.argv) > 3:
            end = int(sys.argv[3])
        if len(sys.argv) > 4:
            old = sys.argv[4]
        if len(sys.argv) > 5:
            new = sys.argv[5]
        
        rename_fields_by_position(input_file, input_file, start, end, old, new)